import { afterAll, describe, expect, it } from "vitest";
import {
  createHarness,
  createRunWith,
  disposeHarness,
  startEvalRunner,
  waitUntil,
  type Harness,
} from "./testkit";

const harnesses: Harness[] = [];

async function makeHarness(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
  const harness = await createHarness(options);
  harnesses.push(harness);
  return harness;
}

afterAll(async () => {
  for (const harness of harnesses) await disposeHarness(harness);
});

describe("knowledge card pipeline (mock)", () => {
  it("runs the full spike DAG: brief → storyboard → 4 pages → manifest", async () => {
    const harness = await makeHarness({ mock: { latencyMs: 1 } });
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, {
      topic: "量子纠缠",
      generateCoverCandidates: true,
    });

    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded");
    await runner.stop();

    const finalRun = await harness.runRepo.require(runId);
    expect(finalRun.status).toBe("succeeded");

    const assets = await harness.assetRepo.listByRun(runId);
    expect(assets.filter((a) => a.kind === "generated")).toHaveLength(4);
    expect(assets.find((a) => a.kind === "export-manifest")).toBeDefined();

    // RunSnapshot 冻结了渠道级并发；Mock 默认 0（不限制）
    const snapshot = JSON.parse(finalRun.snapshotJson ?? "{}") as {
      concurrency?: { channels?: Array<{ type: string; max: number }> };
    };
    expect(snapshot.concurrency?.channels).toEqual([
      { id: "mock", type: "text", max: 0 },
      { id: "mock", type: "image", max: 0 },
    ]);

    // 4 张正文页 + 3 张封面候选（generate-covers 增强工序）
    expect((await harness.runRepo.runTotals(runId)).images).toBe(7);
  });

  it("retries only the failed page, not the whole set", async () => {
    let imageCalls = 0;
    const harness = await makeHarness({
      mock: {
        latencyMs: 1,
        // 第 2 页首次生成失败（按页码标签匹配）
        shouldFailImage: (request) => {
          imageCalls += 1;
          return request.prompt.includes("页码：2/4") && imageCalls <= 4;
        },
      },
    });
    const runner = startEvalRunner(harness);
    const { runId } = await createRunWith(harness, { topic: "图书推荐方法" });

    // 先进入 failed（第 2 页失败），Runner 自动重试后补齐该页
    await waitUntil(async () => (await harness.runRepo.require(runId)).status === "succeeded", 20_000);
    await runner.stop();

    const assets = await harness.assetRepo.listByRun(runId);
    expect(assets.filter((a) => a.kind === "generated")).toHaveLength(4);
    // brief 与 storyboard 节点只执行过一次（重试不重跑已成功节点）
    const nodeRuns = await harness.runRepo.listNodeRuns(runId);
    const briefRuns = nodeRuns.filter((n) => n.nodeName === "generate-brief");
    expect(briefRuns).toHaveLength(1);
    const imageRuns = nodeRuns.filter((n) => n.nodeName === "generate-images");
    // 第 2 页有一次 failed + 一次 succeeded；其余页面各一次 succeeded
    expect(imageRuns.filter((n) => n.status === "succeeded")).toHaveLength(4);
    expect(imageRuns.filter((n) => n.status === "failed")).toHaveLength(1);
  });

  it("supports a manual checkpoint retry after the automatic attempts are exhausted", async () => {
    let recover = false;
    const harness = await makeHarness({
      mock: {
        latencyMs: 1,
        shouldFailImage: (request) => !recover && request.prompt.includes("页码：2/4"),
      },
    });
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, { topic: "检查点恢复" });

    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "failed", 20_000);
    expect((await harness.runRepo.require(runId)).status).toBe("failed");
    const failedPageNode = (await harness.runRepo.listNodeRuns(runId)).find(
      (node) => node.nodeName === "generate-images" && node.status === "failed",
    );
    expect(JSON.parse(failedPageNode?.outputRef ?? "{}")).toMatchObject({ pageIndex: 1 });

    recover = true;
    await harness.runRepo.updateStatus(runId, "queued", { errorSummary: null });
    const retry = await harness.jobRepo.createOrReuse({
      kind: "knowledge_card_run",
      runId,
      idempotencyKey: `manual-checkpoint:${runId}`,
      payloadJson: JSON.stringify({ mode: "checkpoint", sourceRunId: runId }),
      maxAttempts: 3,
    });
    await harness.jobRepo.appendEvent(retry.job.id, "created", "retry=checkpoint");
    await waitUntil(async () => (await harness.runRepo.require(runId)).status === "succeeded", 20_000);
    await runner.stop();

    expect((await harness.jobRepo.require(retry.job.id)).status).toBe("succeeded");
    const nodeRuns = await harness.runRepo.listNodeRuns(runId);
    expect(nodeRuns.filter((node) => node.nodeName === "generate-brief")).toHaveLength(1);
    expect(nodeRuns.filter((node) => node.nodeName === "generate-storyboard")).toHaveLength(1);
    expect(nodeRuns.filter((node) => node.nodeName === "generate-images" && node.status === "succeeded")).toHaveLength(4);
    // 初次执行的 4 页 + 自动重试 2 次失败页 + 手动检查点补 1 页
    expect(harness.mock.controls.calls.image).toBe(7);
  });

  it("reuses an idempotency key instead of creating a duplicate job", async () => {
    const harness = await makeHarness();
    const { runId } = await createRunWith(harness, { topic: "幂等键测试" });
    const first = await harness.jobRepo.createOrReuse({
      kind: "knowledge_card_run",
      runId,
      idempotencyKey: "workspace:platform:project:v1:generate",
    });
    const second = await harness.jobRepo.createOrReuse({
      kind: "knowledge_card_run",
      runId,
      idempotencyKey: "workspace:platform:project:v1:generate",
    });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  it("recovers orphaned running jobs on boot and completes them", async () => {
    const harness = await makeHarness({ mock: { latencyMs: 1 } });
    const { jobId } = await createRunWith(harness, { topic: "重启恢复" });
    // 模拟上次进程崩溃：任务处于 running
    await harness.jobRepo.claimNext("dead-process", 60_000);

    const runner = startEvalRunner(harness); // start() 会 recoverOrphans
    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded");
    await runner.stop();

    const events = (await harness.jobRepo.listEvents(jobId)).map((e) => e.event);
    expect(events).toContain("orphan_recovered");
    expect(events).toContain("claimed");
    const job = await harness.jobRepo.require(jobId);
    expect(job.attempts).toBeGreaterThanOrEqual(1);
  });

  it("cancels a running job and never reaches terminal success afterwards", async () => {
    const harness = await makeHarness({ mock: { latencyMs: 2_000 } });
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, { topic: "取消测试" });

    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "running");
    const cancelAt = Date.now();
    expect(await runner.cancel(jobId)).toBe(true);
    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "cancelled");
    const cancelLatencyMs = Date.now() - cancelAt;
    await waitUntil(async () => (await harness.runRepo.require(runId)).status !== "running");
    await runner.stop();

    expect((await harness.jobRepo.require(jobId)).status).toBe("cancelled");
    expect((await harness.runRepo.require(runId)).status).toBe("cancelled");
    // signal 已贯穿到模型调用层：进行中的调用被立即中断，而不是等它完成后在阶段间退出
    expect(cancelLatencyMs).toBeLessThan(1_500);
    expect(harness.mock.controls.calls.image).toBe(0);
  });
});

describe("approval gate (requireApproval)", () => {
  it("holds the run at awaiting_approval until review approves", async () => {
    const harness = await makeHarness({ mock: { latencyMs: 1 } });
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, { topic: "审批门测试", requireApproval: true });

    await waitUntil(async () => {
      const status = (await harness.runRepo.require(runId)).status;
      return status === "awaiting_approval" || status === "failed";
    }, 20_000);
    expect((await harness.runRepo.require(runId)).status).toBe("awaiting_approval");
    // job 正常结束，run 挂起等待人工确认
    expect((await harness.jobRepo.require(jobId)).status).toBe("succeeded");

    await harness.runRepo.setReview(runId, "approved");
    await harness.runRepo.updateStatus(runId, "succeeded");
    await runner.stop();

    expect((await harness.runRepo.require(runId)).status).toBe("succeeded");
    expect((await harness.assetRepo.listByRun(runId)).filter((a) => a.kind === "generated")).toHaveLength(4);
  });
});
