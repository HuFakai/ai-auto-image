import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssetRepo,
  AssetStore,
  JobRepo,
  ProjectRepo,
  PromptRepo,
  ProviderRepo,
  RevisionRepo,
  RunRepo,
  openDatabase,
  type OpenDatabase,
} from "@aai/storage";
import { createMockProvider, type MockProviderOptions } from "@aai/provider-mock";
import { CreateRunInputSchema, type CreateRunInput } from "@aai/shared-schemas";
import { JobRunner } from "./job-runner";
import { registerKnowledgeCardPipeline, type ImageRoute, type TextRoute, type WorkflowDeps } from "./pipeline/knowledge-cards";
import { registerComicPipeline, type ComicPipelineDeps } from "./pipeline/comic";
import { registerPageRegenPipeline, type PageRegenDeps } from "./pipeline/page-regen";
import { registerCoverPipeline, type CoverDeps } from "./pipeline/cover";

/** 评测与集成测试共用的流水线装置：进程内 PGlite + Mock Provider + 临时目录 */
export interface Harness {
  db: OpenDatabase;
  deps: WorkflowDeps;
  comicDeps: ComicPipelineDeps;
  pageRegenDeps: PageRegenDeps;
  coverDeps: CoverDeps;
  revisionRepo: RevisionRepo;
  jobRepo: JobRepo;
  runRepo: RunRepo;
  projectRepo: ProjectRepo;
  assetRepo: AssetRepo;
  mock: ReturnType<typeof createMockProvider>;
  assetsRoot: string;
  exportsRoot: string;
}

export function migrationsDir(): string {
  // 拆开变量以避免打包器把 import.meta.url 当静态资产解析（testkit 不进入 web 运行时路径）
  const moduleUrl = import.meta.url;
  return new URL("../../storage/drizzle", moduleUrl).pathname;
}

export async function createHarness(options: { mock?: MockProviderOptions } = {}): Promise<Harness> {
  const db = await openDatabase({ migrationsFolder: migrationsDir() });
  const assetsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aai-eval-assets-"));
  const exportsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aai-eval-exports-"));
  const mock = createMockProvider(options.mock);

  const deps: WorkflowDeps = {
    runRepo: new RunRepo(db.db),
    jobRepo: new JobRepo(db.db),
    promptRepo: new PromptRepo(db.db),
    assetRepo: new AssetRepo(db.db),
    providerRepo: new ProviderRepo(db.db),
    assetStore: new AssetStore(assetsRoot),
    textRoutes: [{ config: mock.bundle.config, model: "mock-text", text: mock.bundle.text! }],
    imageRoutes: [{ config: mock.bundle.config, model: "mock-image", image: mock.bundle.image! }],
    visualQuality: mock.bundle.visualQuality,
    assetsDir: assetsRoot,
    exportsDir: exportsRoot,
  };

  const revisionRepo = new RevisionRepo(db.db);
  const comicDeps: ComicPipelineDeps = {
    runRepo: deps.runRepo,
    jobRepo: deps.jobRepo,
    assetRepo: deps.assetRepo,
    providerRepo: deps.providerRepo,
    revisionRepo,
    assetStore: deps.assetStore,
    textRoutes: deps.textRoutes as TextRoute[],
    imageRoutes: deps.imageRoutes as ImageRoute[],
    visualQuality: mock.bundle.visualQuality,
    assetsDir: assetsRoot,
    exportsDir: exportsRoot,
  };
  const pageRegenDeps: PageRegenDeps = {
    runRepo: deps.runRepo,
    jobRepo: deps.jobRepo,
    assetRepo: deps.assetRepo,
    providerRepo: deps.providerRepo,
    revisionRepo,
    assetStore: deps.assetStore,
    imageRoutes: deps.imageRoutes,
    assetsDir: assetsRoot,
    visualQuality: mock.bundle.visualQuality,
  };
  const coverDeps: CoverDeps = {
    runRepo: deps.runRepo,
    jobRepo: deps.jobRepo,
    assetRepo: deps.assetRepo,
    providerRepo: deps.providerRepo,
    assetStore: deps.assetStore,
    textRoutes: deps.textRoutes,
    imageRoutes: deps.imageRoutes,
    assetsDir: assetsRoot,
  };

  return {
    db,
    deps,
    comicDeps,
    pageRegenDeps,
    coverDeps,
    revisionRepo,
    jobRepo: deps.jobRepo,
    runRepo: deps.runRepo,
    projectRepo: new ProjectRepo(db.db),
    assetRepo: deps.assetRepo,
    mock,
    assetsRoot,
    exportsRoot,
  };
}

export async function disposeHarness(harness: Harness): Promise<void> {
  await harness.db.close();
  fs.rmSync(harness.assetsRoot, { recursive: true, force: true });
  fs.rmSync(harness.exportsRoot, { recursive: true, force: true });
}

export function startEvalRunner(harness: Harness): JobRunner {
  const runner = new JobRunner(harness.jobRepo, { pollIntervalMs: 10, holder: "eval-runner" });
  registerKnowledgeCardPipeline(runner, harness.deps);
  registerPageRegenPipeline(runner, harness.pageRegenDeps);
  registerComicPipeline(runner, harness.comicDeps);
  registerCoverPipeline(runner, harness.coverDeps);
  runner.start();
  return runner;
}

export async function createRunWith(
  harness: Harness,
  input: Partial<CreateRunInput> & { topic: string },
): Promise<{ runId: string; jobId: string }> {
  const project = await harness.projectRepo.create({ title: input.topic });
  const parsed = CreateRunInputSchema.parse(input);
  const run = await harness.runRepo.create({ projectId: project.id, inputJson: JSON.stringify(parsed) });
  const kind = parsed.recipe === "comic_story" || parsed.recipe === "strip_comic" ? "comic_story_run" : "knowledge_card_run";
  const { job } = await harness.jobRepo.createOrReuse({ kind, runId: run.id });
  return { runId: run.id, jobId: job.id };
}

export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
