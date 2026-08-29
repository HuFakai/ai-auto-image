import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Semaphore } from "@aai/ai-core";
import {
  AssetRepo,
  AssetStore,
  JobRepo,
  ProjectRepo,
  PromptRepo,
  ProviderRepo,
  RunRepo,
  openDatabase,
  type OpenDatabase,
} from "@aai/storage";
import { createMockProvider, type MockProviderOptions } from "@aai/provider-mock";
import { CreateRunInputSchema, type CreateRunInput } from "@aai/shared-schemas";
import { JobRunner } from "./job-runner";
import { registerKnowledgeCardPipeline, type WorkflowDeps } from "./pipeline/knowledge-cards";

/** 评测与集成测试共用的流水线装置：内存 SQLite + Mock Provider + 临时目录 */
export interface Harness {
  db: OpenDatabase;
  deps: WorkflowDeps;
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

export function createHarness(options: { mock?: MockProviderOptions } = {}): Harness {
  const db = openDatabase({ sqlitePath: ":memory:", migrationsFolder: migrationsDir() });
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
    imageApiSemaphore: new Semaphore(4),
    serverMaxConcurrency: 4,
    postprocessMax: 1,
    assetsDir: assetsRoot,
    exportsDir: exportsRoot,
    templateVersion: "darkroom-knowledge@1",
  };

  return {
    db,
    deps,
    jobRepo: deps.jobRepo,
    runRepo: deps.runRepo,
    projectRepo: new ProjectRepo(db.db),
    assetRepo: deps.assetRepo,
    mock,
    assetsRoot,
    exportsRoot,
  };
}

export function disposeHarness(harness: Harness): void {
  harness.db.close();
  fs.rmSync(harness.assetsRoot, { recursive: true, force: true });
  fs.rmSync(harness.exportsRoot, { recursive: true, force: true });
}

export function startEvalRunner(harness: Harness): JobRunner {
  const runner = new JobRunner(harness.jobRepo, { pollIntervalMs: 10, holder: "eval-runner" });
  registerKnowledgeCardPipeline(runner, harness.deps);
  runner.start();
  return runner;
}

export function createRunWith(
  harness: Harness,
  input: Partial<CreateRunInput> & { topic: string },
): { runId: string; jobId: string } {
  const project = harness.projectRepo.create({ title: input.topic });
  const parsed = CreateRunInputSchema.parse(input);
  const run = harness.runRepo.create({ projectId: project.id, inputJson: JSON.stringify(parsed) });
  const { job } = harness.jobRepo.createOrReuse({ kind: "knowledge_card_run", runId: run.id });
  return { runId: run.id, jobId: job.id };
}

export async function waitUntil(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
