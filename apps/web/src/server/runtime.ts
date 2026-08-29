import fs from "node:fs";
import path from "node:path";
import { Semaphore, type TextModel, type VisualQualityModel } from "@aai/ai-core";
import {
  AssetRepo,
  AssetStore,
  BrandKitRepo,
  ChannelRepo,
  JobRepo,
  ProjectRepo,
  PromptRepo,
  ProviderRepo,
  RevisionRepo,
  RunRepo,
  SessionRepo,
  UserRepo,
  openDatabase,
  type OpenDatabase,
} from "@aai/storage";
import {
  JobRunner,
  registerComicPipeline,
  registerKnowledgeCardPipeline,
  registerPageRegenPipeline,
  type ImageRoute,
  type TextRoute,
} from "@aai/workflow-engine";
import { autoImportFromEnv, ChannelService, mockRoutes } from "./channel-service";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 加载仓库根目录 .env（Next 只自动读 apps/web 下的 env 文件）；已存在的环境变量优先 */
function loadRootEnvFile(): void {
  const candidates = [path.join(process.cwd(), "../../.env"), path.join(process.cwd(), ".env")];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const content = fs.readFileSync(candidate, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}

function resolveMigrationsDir(): string {
  const candidates = [
    process.env.SQLITE_MIGRATIONS_DIR,
    // pnpm dev：apps/web → packages/storage/drizzle
    path.join(process.cwd(), "../../packages/storage/drizzle"),
    // standalone：迁移拷贝到镜像 /app/drizzle
    path.join(process.cwd(), "drizzle"),
    path.join(process.cwd(), "packages/storage/drizzle"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "meta", "_journal.json"))) return candidate;
  }
  throw new Error(
    `drizzle migrations not found; set SQLITE_MIGRATIONS_DIR (tried: ${candidates.join(", ")})`,
  );
}

export interface RuntimeConfig {
  dataDir: string;
  sqlitePath: string;
  assetsDir: string;
  exportsDir: string;
  serverMaxConcurrency: number;
  defaultConcurrency: number;
  postprocessMax: number;
  providerMode: "mock" | "partial" | "real";
  providerLabel: string;
}

/** 流水线依赖对象：渠道热更新通过就地替换其中的路由数组实现 */
interface PipelineDeps {
  textRoutes: TextRoute[];
  imageRoutes: ImageRoute[];
  visualQuality: VisualQualityModel | null;
}

export interface Runtime {
  config: RuntimeConfig;
  db: OpenDatabase;
  projectRepo: ProjectRepo;
  runRepo: RunRepo;
  jobRepo: JobRepo;
  promptRepo: PromptRepo;
  assetRepo: AssetRepo;
  providerRepo: ProviderRepo;
  channelRepo: ChannelRepo;
  channelService: ChannelService;
  brandKitRepo: BrandKitRepo;
  revisionRepo: RevisionRepo;
  userRepo: UserRepo;
  sessionRepo: SessionRepo;
  assetStore: AssetStore;
  imageApiSemaphore: Semaphore;
  runner: JobRunner;
  /** 重新从数据库装配渠道路由（渠道增删改、启停、排序后调用） */
  refreshChannels(): Promise<void>;
  /** 导出文案等附加能力使用的首选文本模型（未配置时 null） */
  preferredTextModel(): TextModel | null;
  /** 计算某次请求的有效并发（min(requested, serverMax, providerMax)） */
  effectiveConcurrency(requested: number): number;
}

declare global {
  var __aaiRuntimePromise: Promise<Runtime> | undefined;
}

/** 过期会话清理周期（低频，unref 不阻塞进程退出） */
const SESSION_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 模块级句柄：buildRuntime 进程内仅执行一次，天然不会重复创建 */
let sessionCleanupTimer: NodeJS.Timeout | null = null;

export function getRuntime(): Promise<Runtime> {
  if (!globalThis.__aaiRuntimePromise) {
    // 初始化失败（如远程 PG 短暂不可达）时重置缓存，允许下一次调用重试
    globalThis.__aaiRuntimePromise = initRuntime().catch((error: unknown) => {
      globalThis.__aaiRuntimePromise = undefined;
      throw error;
    });
  }
  return globalThis.__aaiRuntimePromise;
}

async function initRuntime(): Promise<Runtime> {
  loadRootEnvFile();
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  const paths: RuntimePaths = {
    dataDir,
    sqlitePath: process.env.SQLITE_PATH ?? path.join(dataDir, "db", "app.db"),
    assetsDir: process.env.ASSETS_DIR ?? path.join(dataDir, "assets"),
    exportsDir: process.env.EXPORTS_DIR ?? path.join(dataDir, "exports"),
    serverMaxConcurrency: envInt("IMAGE_GENERATION_CONCURRENCY_MAX", 4),
    defaultConcurrency: envInt("IMAGE_GENERATION_CONCURRENCY_DEFAULT", 1),
    postprocessMax: envInt("IMAGE_POSTPROCESS_CONCURRENCY_MAX", 1),
  };

  const db = await openDatabase({ url: process.env.DATABASE_URL, migrationsFolder: resolveMigrationsDir() });
  try {
    return await buildRuntime(db, paths);
  } catch (error) {
    // 初始化失败：关闭连接防泄漏，再向上抛（getRuntime 会重置缓存允许重试）
    await db.close().catch(() => {});
    throw error;
  }
}

interface RuntimePaths {
  dataDir: string;
  sqlitePath: string;
  assetsDir: string;
  exportsDir: string;
  serverMaxConcurrency: number;
  defaultConcurrency: number;
  postprocessMax: number;
}

async function buildRuntime(db: OpenDatabase, paths: RuntimePaths): Promise<Runtime> {
  const { dataDir, sqlitePath, assetsDir, exportsDir, serverMaxConcurrency, defaultConcurrency, postprocessMax } = paths;
  const channelService = new ChannelService(new ChannelRepo(db.db), dataDir);
  const brandKitRepo = new BrandKitRepo(db.db);
  const seededKits = await brandKitRepo.seedBuiltIns();
  if (seededKits > 0) {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: `seeded ${seededKits} built-in brand kits` }),
    );
  }
  // 渠道表为空且环境变量有配置时自动导入一次（之后以设置页管理为准）
  const imported = await autoImportFromEnv(channelService);
  if (imported > 0) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: `imported ${imported} channel(s) from env into settings`,
      }),
    );
  }

  const mock = mockRoutes();
  const config: RuntimeConfig = {
    dataDir,
    sqlitePath,
    assetsDir,
    exportsDir,
    serverMaxConcurrency,
    defaultConcurrency,
    postprocessMax,
    providerMode: "mock",
    providerLabel: "Mock（未配置渠道）",
  };

  const runtime: Runtime = {
    config,
    db,
    projectRepo: new ProjectRepo(db.db),
    runRepo: new RunRepo(db.db),
    jobRepo: new JobRepo(db.db),
    promptRepo: new PromptRepo(db.db),
    assetRepo: new AssetRepo(db.db),
    providerRepo: new ProviderRepo(db.db),
    channelRepo: new ChannelRepo(db.db),
    channelService,
    brandKitRepo,
    revisionRepo: new RevisionRepo(db.db),
    userRepo: new UserRepo(db.db),
    sessionRepo: new SessionRepo(db.db),
    assetStore: new AssetStore(assetsDir),
    imageApiSemaphore: new Semaphore(serverMaxConcurrency),
    runner: new JobRunner(new JobRepo(db.db), {
      maxConcurrent: envInt("JOB_RUNNER_CONCURRENCY", 1),
    }),
    effectiveConcurrency(requested: number): number {
      const providerMax = pipelineDeps.imageRoutes
        .map((route) => route.config.imageConcurrencyMax)
        .filter((value): value is number => typeof value === "number");
      return Math.max(
        1,
        Math.min(
          requested,
          serverMaxConcurrency,
          ...(providerMax.length > 0 ? [Math.min(...providerMax)] : []),
        ),
      );
    },
    preferredTextModel(): TextModel | null {
      return pipelineDeps.textRoutes[0]?.text ?? null;
    },
    async refreshChannels(): Promise<void> {
      const assembled = await channelService.assembleRoutes();
      pipelineDeps.textRoutes = assembled.textRoutes;
      pipelineDeps.imageRoutes = assembled.imageRoutes;
      pipelineDeps.visualQuality = assembled.visualQuality;
      config.providerMode = assembled.mode;
      config.providerLabel = assembled.label;
    },
  };

  /** 流水线读取的依赖对象：字段由 refreshChannels 就地替换 */
  const pipelineDeps: PipelineDeps = {
    textRoutes: [mock.text],
    imageRoutes: [mock.image],
    visualQuality: null,
  };

  registerKnowledgeCardPipeline(runtime.runner, {
    runRepo: runtime.runRepo,
    jobRepo: runtime.jobRepo,
    promptRepo: runtime.promptRepo,
    assetRepo: runtime.assetRepo,
    providerRepo: runtime.providerRepo,
    assetStore: runtime.assetStore,
    get textRoutes() {
      return pipelineDeps.textRoutes;
    },
    set textRoutes(routes: TextRoute[]) {
      pipelineDeps.textRoutes = routes;
    },
    get imageRoutes() {
      return pipelineDeps.imageRoutes;
    },
    set imageRoutes(routes: ImageRoute[]) {
      pipelineDeps.imageRoutes = routes;
    },
    get visualQuality() {
      return pipelineDeps.visualQuality;
    },
    set visualQuality(model: PipelineDeps["visualQuality"]) {
      pipelineDeps.visualQuality = model;
    },
    imageApiSemaphore: runtime.imageApiSemaphore,
    serverMaxConcurrency,
    postprocessMax,
    assetsDir,
    exportsDir,
    templateVersion: "darkroom-knowledge@1",
  });

  registerComicPipeline(runtime.runner, {
    runRepo: runtime.runRepo,
    jobRepo: runtime.jobRepo,
    assetRepo: runtime.assetRepo,
    providerRepo: runtime.providerRepo,
    revisionRepo: runtime.revisionRepo,
    assetStore: runtime.assetStore,
    get textRoutes() {
      return pipelineDeps.textRoutes;
    },
    set textRoutes(routes) {
      pipelineDeps.textRoutes = routes;
    },
    get imageRoutes() {
      return pipelineDeps.imageRoutes;
    },
    set imageRoutes(routes) {
      pipelineDeps.imageRoutes = routes;
    },
    // 与 knowledge-cards 一致：绑定 get/set 存取器，渠道热更新时读取最新值
    get visualQuality() {
      return pipelineDeps.visualQuality;
    },
    set visualQuality(model: PipelineDeps["visualQuality"]) {
      pipelineDeps.visualQuality = model;
    },
    imageApiSemaphore: runtime.imageApiSemaphore,
    assetsDir,
    exportsDir,
    serverMaxConcurrency,
  });

  registerPageRegenPipeline(runtime.runner, {
    runRepo: runtime.runRepo,
    jobRepo: runtime.jobRepo,
    assetRepo: runtime.assetRepo,
    providerRepo: runtime.providerRepo,
    revisionRepo: runtime.revisionRepo,
    assetStore: runtime.assetStore,
    get imageRoutes() {
      return pipelineDeps.imageRoutes;
    },
    set imageRoutes(routes) {
      pipelineDeps.imageRoutes = routes;
    },
    imageApiSemaphore: runtime.imageApiSemaphore,
    postprocessMax,
    assetsDir,
    get visualQuality() {
      return pipelineDeps.visualQuality;
    },
    set visualQuality(model) {
      pipelineDeps.visualQuality = model;
    },
  });

  await runtime.refreshChannels();

  // 低频清理过期会话（unref 不阻塞进程退出；模块级句柄，进程内仅创建一次）
  if (!sessionCleanupTimer) {
    sessionCleanupTimer = setInterval(() => {
      runtime.sessionRepo.deleteExpired().catch((error) => {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            msg: "session cleanup failed",
            error: String(error),
          }),
        );
      });
    }, SESSION_CLEANUP_INTERVAL_MS);
    sessionCleanupTimer.unref();
  }

  return runtime;
}

export async function startRuntimeRunner(): Promise<void> {
  const runtime = await getRuntime();
  runtime.runner.start();
}
