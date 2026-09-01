import fs from "node:fs";
import path from "node:path";
import type { TextModel, VisualQualityModel } from "@aai/ai-core";
import type { CreateRunInput } from "@aai/shared-schemas";
import { toBeijingIsoString } from "@aai/shared-schemas";
import {
  AssetRepo,
  AssetStore,
  BrandKitRepo,
  ChannelModelRepo,
  ChannelRepo,
  CreditPackageRepo,
  JobRepo,
  LedgerRepo,
  OrderRepo,
  PaymentConfigRepo,
  PlanRepo,
  ProjectRepo,
  PromptRepo,
  ProviderRepo,
  RevisionRepo,
  RunRepo,
  SessionRepo,
  SubscriptionRepo,
  UserRepo,
  WalletRepo,
  openDatabase,
  type OpenDatabase,
} from "@aai/storage";
import {
  JobRunner,
  registerComicPipeline,
  registerCoverPipeline,
  registerKnowledgeCardPipeline,
  registerPageRegenPipeline,
  selectTextRoutes,
  type ImageRoute,
  type TextRoute,
} from "@aai/workflow-engine";
import { autoImportFromEnv, ChannelService, mockRoutes } from "./channel-service";
import { BillingService } from "./billing";
import { PayService } from "./pay/service";

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
  channelModelRepo: ChannelModelRepo;
  channelService: ChannelService;
  brandKitRepo: BrandKitRepo;
  revisionRepo: RevisionRepo;
  userRepo: UserRepo;
  sessionRepo: SessionRepo;
  planRepo: PlanRepo;
  packageRepo: CreditPackageRepo;
  orderRepo: OrderRepo;
  walletRepo: WalletRepo;
  subscriptionRepo: SubscriptionRepo;
  ledgerRepo: LedgerRepo;
  paymentConfigRepo: PaymentConfigRepo;
  billing: BillingService;
  pay: PayService;
  assetStore: AssetStore;
  runner: JobRunner;
  /** 重新从数据库装配渠道路由（渠道增删改、启停、排序后调用） */
  refreshChannels(): Promise<void>;
  /** 按作品快照选择附加能力使用的首选文本路由（未配置/不可用时 null） */
  preferredTextRoute(input?: CreateRunInput): TextRoute | null;
  /** 导出文案等附加能力使用的首选文本模型（未配置时 null） */
  preferredTextModel(): TextModel | null;
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
}

async function buildRuntime(db: OpenDatabase, paths: RuntimePaths): Promise<Runtime> {
  const { dataDir, sqlitePath, assetsDir, exportsDir } = paths;
  const channelRepo = new ChannelRepo(db.db);
  const channelModelRepo = new ChannelModelRepo(db.db);
  const channelService = new ChannelService(channelRepo, dataDir, channelModelRepo);
  const brandKitRepo = new BrandKitRepo(db.db);
  const seededKits = await brandKitRepo.seedBuiltIns();
  if (seededKits > 0) {
    console.log(
      JSON.stringify({ ts: toBeijingIsoString(), level: "info", msg: `seeded ${seededKits} built-in brand kits` }),
    );
  }
  // 渠道表为空且环境变量有配置时自动导入一次（之后以设置页管理为准）
  const imported = await autoImportFromEnv(channelService);
  if (imported > 0) {
    console.log(
      JSON.stringify({
        ts: toBeijingIsoString(),
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
    providerMode: "mock",
    providerLabel: "Mock（未配置渠道）",
  };

  const planRepo = new PlanRepo(db.db);
  const packageRepo = new CreditPackageRepo(db.db);
  const orderRepo = new OrderRepo(db.db);
  const walletRepo = new WalletRepo(db.db);
  const subscriptionRepo = new SubscriptionRepo(db.db);
  const ledgerRepo = new LedgerRepo(db.db);
  const paymentConfigRepo = new PaymentConfigRepo(db.db);
  const seeded = await planRepo.ensureDefaults() + (await packageRepo.ensureDefaults());
  if (seeded > 0) {
    console.log(
      JSON.stringify({ ts: toBeijingIsoString(), level: "info", msg: `seeded ${seeded} default billing plan(s)/package(s)` }),
    );
  }
  const runRepo = new RunRepo(db.db);
  const billing = new BillingService(walletRepo, ledgerRepo, planRepo, subscriptionRepo, runRepo);
  // 生图计费：流水线先预留额度，节点成功产出图片后结算，失败/取消由流水线释放剩余预留。
  runRepo.onNodeSucceeded(billing.nodeImageHook());
  const pay = new PayService({
    dataDir,
    paymentConfigRepo,
    orderRepo,
    planRepo,
    packageRepo,
    billing,
    logError: (msg, extra = {}) => {
      console.log(JSON.stringify({ ts: toBeijingIsoString(), level: "error", msg, ...extra }));
    },
  });

  const runtime: Runtime = {
    config,
    db,
    projectRepo: new ProjectRepo(db.db),
    runRepo,
    jobRepo: new JobRepo(db.db),
    promptRepo: new PromptRepo(db.db),
    assetRepo: new AssetRepo(db.db),
    providerRepo: new ProviderRepo(db.db),
    channelRepo,
    channelModelRepo,
    channelService,
    brandKitRepo,
    revisionRepo: new RevisionRepo(db.db),
    userRepo: new UserRepo(db.db),
    sessionRepo: new SessionRepo(db.db),
    planRepo,
    packageRepo,
    orderRepo,
    walletRepo,
    subscriptionRepo,
    ledgerRepo,
    paymentConfigRepo,
    billing,
    pay,
    assetStore: new AssetStore(assetsDir),
    runner: new JobRunner(new JobRepo(db.db)),
    preferredTextRoute(input?: CreateRunInput): TextRoute | null {
      try {
        const routes = input ? selectTextRoutes(input, pipelineDeps.textRoutes) : pipelineDeps.textRoutes;
        return routes[0] ?? null;
      } catch {
        // 作品绑定的文本模型已经被管理员停用时，不静默切换到其它文本模型。
        return null;
      }
    },
    preferredTextModel(): TextModel | null {
      return pipelineDeps.textRoutes[0]?.text ?? null;
    },
    async refreshChannels(): Promise<void> {
      const assembled = await channelService.assembleRoutes();
      // 渠道全部禁用/为空时回落 Mock 路由：保证系统可用（否则任务会以"无可用路由"必败）
      const mock = mockRoutes();
      pipelineDeps.textRoutes = assembled.textRoutes.length > 0 ? assembled.textRoutes : [mock.text];
      pipelineDeps.imageRoutes = assembled.imageRoutes.length > 0 ? assembled.imageRoutes : [mock.image];
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
    assetsDir,
    exportsDir,
    reserveImageCredits: (runId, amount) => billing.reserveRunCreditsForRun(runId, amount),
    releaseImageCredits: (runId) => billing.releaseRunCredits(runId),
    reserveModelCredits: (runId, amount) => billing.reserveRunCreditsForRun(runId, amount),
    captureModelCredits: (runId, nodeRunId, amount, model) =>
      billing.captureModelCreditsForRun(runId, nodeRunId, amount, model),
    releaseModelCredits: (runId, amount) => billing.releaseRunCreditsAmount(runId, amount),
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
    assetsDir,
    exportsDir,
    reserveImageCredits: (runId, amount) => billing.reserveRunCreditsForRun(runId, amount),
    releaseImageCredits: (runId) => billing.releaseRunCredits(runId),
    reserveModelCredits: (runId, amount) => billing.reserveRunCreditsForRun(runId, amount),
    captureModelCredits: (runId, nodeRunId, amount, model) =>
      billing.captureModelCreditsForRun(runId, nodeRunId, amount, model),
    releaseModelCredits: (runId, amount) => billing.releaseRunCreditsAmount(runId, amount),
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
    assetsDir,
    reserveImageCredits: (runId, amount) => billing.reserveRunCreditsForRun(runId, amount),
    releaseImageCredits: (runId) => billing.releaseRunCredits(runId),
    get visualQuality() {
      return pipelineDeps.visualQuality;
    },
    set visualQuality(model) {
      pipelineDeps.visualQuality = model;
    },
  });

  registerCoverPipeline(runtime.runner, {
    runRepo: runtime.runRepo,
    jobRepo: runtime.jobRepo,
    assetRepo: runtime.assetRepo,
    providerRepo: runtime.providerRepo,
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
    assetsDir,
    reserveImageCredits: (runId, amount) => billing.reserveRunCreditsForRun(runId, amount),
    releaseImageCredits: (runId) => billing.releaseRunCredits(runId),
    reserveModelCredits: (runId, amount) => billing.reserveRunCreditsForRun(runId, amount),
    captureModelCredits: (runId, nodeRunId, amount, model) =>
      billing.captureModelCreditsForRun(runId, nodeRunId, amount, model),
    releaseModelCredits: (runId, amount) => billing.releaseRunCreditsAmount(runId, amount),
  });

  await runtime.refreshChannels();

  // 低频清理过期会话（unref 不阻塞进程退出；模块级句柄，进程内仅创建一次）
  if (!sessionCleanupTimer) {
    sessionCleanupTimer = setInterval(() => {
      runtime.sessionRepo.deleteExpired().catch((error) => {
        console.log(
          JSON.stringify({
            ts: toBeijingIsoString(),
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
