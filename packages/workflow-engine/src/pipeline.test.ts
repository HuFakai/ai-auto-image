import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Semaphore } from "@aai/ai-core";
import {
  AssetRepo,
  JobRepo,
  ProjectRepo,
  PromptRepo,
  ProviderRepo,
  RunRepo,
  AssetStore,
  openDatabase,
  type OpenDatabase,
} from "@aai/storage";
import { createMockProvider } from "@aai/provider-mock";
import { CreateRunInputSchema } from "@aai/shared-schemas";
import { JobRunner } from "./job-runner";
import { registerKnowledgeCardPipeline, type WorkflowDeps } from "./pipeline/knowledge-cards";

function migrationsDir(): string {
  return new URL("../../storage/drizzle", import.meta.url).pathname;
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-wf-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  db: OpenDatabase;
  deps: WorkflowDeps;
  jobRepo: JobRepo;
  runRepo: RunRepo;
  projectRepo: ProjectRepo;
  mock: ReturnType<typeof createMockProvider>;
}

function makeHarness(options: Parameters<typeof createMockProvider>[0] = {}): Harness {
  const db = openDatabase({ sqlitePath: ":memory:", migrationsFolder: migrationsDir() });
  const runRepo = new RunRepo(db.db);
  const jobRepo = new JobRepo(db.db);
  const projectRepo = new ProjectRepo(db.db);
  const assetsRoot = tmpDir();
  const exportsRoot = tmpDir();
  const mock = createMockProvider(options);

  const deps: WorkflowDeps = {
    runRepo,
    jobRepo,
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
  return { db, deps, jobRepo, runRepo, projectRepo, mock };
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function startRunner(harness: Harness): JobRunner {
  const runner = new JobRunner(harness.jobRepo, { pollIntervalMs: 10, holder: "test-runner" });
  registerKnowledgeCardPipeline(runner, harness.deps);
  runner.start();
  return runner;
}

function createRun(harness: Harness, topic: string) {
  const project = harness.projectRepo.create({ title: topic });
  const input = CreateRunInputSchema.parse({ topic });
  const run = harness.runRepo.create({ projectId: project.id, inputJson: JSON.stringify(input) });
  return { project, run, input };
}

describe("knowledge card pipeline (mock)", () => {
  it("runs the full spike DAG: brief → storyboard → 4 pages → manifest", async () => {
    const harness = makeHarness({ latencyMs: 1 });
    const runner = startRunner(harness);
    const { run } = createRun(harness, "量子纠缠");
    const created = harness.jobRepo.createOrReuse({ kind: "knowledge_card_run", runId: run.id });

    await waitUntil(() => harness.jobRepo.require(created.job.id).status === "succeeded");
    await runner.stop();

    const finalRun = harness.runRepo.require(run.id);
    expect(finalRun.status).toBe("succeeded");

    const assets = harness.deps.assetRepo.listByRun(run.id);
    expect(assets.filter((a) => a.kind === "generated")).toHaveLength(4);
    expect(assets.find((a) => a.kind === "export-manifest")).toBeDefined();

    // RunSnapshot 冻结了并发与路由
    const snapshot = JSON.parse(finalRun.snapshotJson ?? "{}") as { concurrency?: { effective?: number } };
    expect(snapshot.concurrency?.effective).toBe(1);

    expect(harness.runRepo.runTotals(run.id).images).toBe(4);
  });

  it("retries only the failed page, not the whole set", async () => {
    let imageCalls = 0;
    const harness = makeHarness({
      latencyMs: 1,
      // 第 2 页首次生成失败（按页码标签匹配）
      shouldFailImage: (request) => {
        imageCalls += 1;
        return request.prompt.includes("页码：2/4") && imageCalls <= 4;
      },
    });
    const runner = startRunner(harness);
    const { run } = createRun(harness, "图书推荐方法");
    harness.jobRepo.createOrReuse({ kind: "knowledge_card_run", runId: run.id });

    // 先进入 failed（第 2 页失败），Runner 自动重试后补齐该页
    await waitUntil(() => harness.runRepo.require(run.id).status === "succeeded", 20_000);
    await runner.stop();

    const assets = harness.deps.assetRepo.listByRun(run.id);
    expect(assets.filter((a) => a.kind === "generated")).toHaveLength(4);
    // brief 与 storyboard 节点只执行过一次（重试不重跑已成功节点）
    const nodeRuns = harness.runRepo.listNodeRuns(run.id);
    const briefRuns = nodeRuns.filter((n) => n.nodeName === "generate-brief");
    expect(briefRuns).toHaveLength(1);
    const imageRuns = nodeRuns.filter((n) => n.nodeName === "generate-images");
    // 第 2 页有一次 failed + 一次 succeeded；其余页面各一次 succeeded
    expect(imageRuns.filter((n) => n.status === "succeeded")).toHaveLength(4);
    expect(imageRuns.filter((n) => n.status === "failed")).toHaveLength(1);
  });

  it("reuses an idempotency key instead of creating a duplicate job", () => {
    const harness = makeHarness();
    const { run } = createRun(harness, "幂等键测试");
    const first = harness.jobRepo.createOrReuse({
      kind: "knowledge_card_run",
      runId: run.id,
      idempotencyKey: "workspace:platform:project:v1:generate",
    });
    const second = harness.jobRepo.createOrReuse({
      kind: "knowledge_card_run",
      runId: run.id,
      idempotencyKey: "workspace:platform:project:v1:generate",
    });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it("recovers orphaned running jobs on boot and completes them", async () => {
    const harness = makeHarness({ latencyMs: 1 });
    const { run } = createRun(harness, "重启恢复");
    const created = harness.jobRepo.createOrReuse({ kind: "knowledge_card_run", runId: run.id });
    // 模拟上次进程崩溃：任务处于 running
    harness.jobRepo.claimNext("dead-process", 60_000);

    const runner = startRunner(harness); // start() 会 recoverOrphans
    await waitUntil(() => harness.jobRepo.require(created.job.id).status === "succeeded");
    await runner.stop();

    const events = harness.jobRepo.listEvents(created.job.id).map((e) => e.event);
    expect(events).toContain("orphan_recovered");
    expect(events).toContain("claimed");
    const job = harness.jobRepo.require(created.job.id);
    expect(job.attempts).toBeGreaterThanOrEqual(1);
    expect(harness.runRepo.require(run.id).status).toBe("succeeded");
  });

  it("cancels a running job and never reaches terminal success afterwards", async () => {
    const harness = makeHarness({ latencyMs: 2_000 });
    const runner = startRunner(harness);
    const { run } = createRun(harness, "取消测试");
    const created = harness.jobRepo.createOrReuse({ kind: "knowledge_card_run", runId: run.id });

    await waitUntil(() => harness.jobRepo.require(created.job.id).status === "running");
    expect(runner.cancel(created.job.id)).toBe(true);
    await waitUntil(() => harness.runRepo.require(run.id).status !== "running");
    await runner.stop();

    expect(harness.jobRepo.require(created.job.id).status).toBe("cancelled");
    expect(harness.runRepo.require(run.id).status).toBe("cancelled");
  });
});
