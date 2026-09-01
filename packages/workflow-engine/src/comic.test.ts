import { afterAll, describe, expect, it } from "vitest";
import {
  buildCharacterAnchorText,
  buildComicPagePrompt,
  runComicConsistencyChecks,
} from "./pipeline/comic";
import {
  createHarness,
  createRunWith,
  disposeHarness,
  startEvalRunner,
  waitUntil,
  type Harness,
} from "./testkit";

const opened: Harness[] = [];
import { CreateRunInputSchema } from "@aai/shared-schemas";

const harnesses: Harness[] = [];
async function makeHarness(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
  const harness = await createHarness(options);
  harnesses.push(harness);
  opened.push(harness);
  return harness;
}

afterAll(async () => {
  for (const harness of opened) await disposeHarness(harness);
});

describe("comic consistency checks", () => {
  const storyboard = {
    title: "测试漫画",
    cast: [{ name: "小知", appearance: "短发少年", outfit: "蓝帽衫", refImagePrompt: "x", forbiddenChanges: [] }],
    pages: [
      {
        index: 0,
        scene: "s1",
        visualPrompt: "v1",
        cast: ["小知"],
        dialogues: [{ speaker: "小知", text: "你好", type: "speech" as const }],
      },
      {
        index: 1,
        scene: "s2",
        visualPrompt: "v2",
        cast: ["路人"],
        dialogues: [{ speaker: "神秘人", text: "猜猜我是谁", type: "speech" as const }],
      },
    ],
  };

  it("flags unknown speakers and cast refs, passes valid pages count", () => {
    const checks = runComicConsistencyChecks(storyboard);
    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.dialogue_attribution?.status).toBe("fail");
    expect(byName.dialogue_attribution?.detail).toContain("神秘人");
    expect(byName.cast_reference?.status).toBe("warn");
    expect(byName.comic_page_count?.status).toBe("fail"); // 2 页 < 3 页下限
  });

  it("builds anchored page prompts with cast appearance and native dialogue", () => {
    const input = CreateRunInputSchema.parse({ recipe: "comic_story", topic: "复利" });
    const prompt = buildComicPagePrompt(input, storyboard, 0);
    expect(prompt).toContain("短发少年");
    expect(prompt).toContain("蓝帽衫");
    expect(prompt).toContain("你好");
    expect(prompt).toContain("必须逐字绘制");
    expect(buildCharacterAnchorText(storyboard.cast)).toContain("禁止变化");
  });
});

describe("comic pipeline (mock, edit-capable route)", () => {
  it("runs end to end: cast → ref image → storyboard+checks → 4 native pages", async () => {
    const harness = await makeHarness({ mock: { latencyMs: 1 } });
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, {
      recipe: "comic_story",
      topic: "什么是复利",
    });
    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded", 20_000);
    await runner.stop();

    expect((await harness.runRepo.require(runId)).status).toBe("succeeded");

    // 角色定妆图
    const refAsset = (await harness.assetRepo.listByRun(runId)).find((a) => a.kind === "reference");
    expect(refAsset).toBeDefined();

    // 分镜与一致性检查已入库
    const storyboardNode = (await harness.runRepo.listNodeRuns(runId)).find(
      (n) => n.nodeName === "generate-comic-storyboard",
    );
    const stored = JSON.parse(storyboardNode!.outputRef!) as {
      value: { pages: unknown[]; cast: Array<{ name: string }> };
      checks: Array<{ name: string; status: string }>;
    };
    expect(stored.value.pages).toHaveLength(4);
    expect(stored.checks.find((c) => c.name === "dialogue_attribution")?.status).toBe("pass");

    // 每页直接落一张由图片模型完成画面与中文对白的成品图
    const generatedPages = (await harness.assetRepo.listByRun(runId)).filter(
      (a) => a.kind === "generated" && a.pageIndex !== null && a.pageIndex >= 0,
    );
    expect(generatedPages).toHaveLength(4);

    // Mock 渠道具备编辑能力 → 走图生图参考链
    const generated = (await harness.assetRepo.listByRun(runId)).find((a) => a.kind === "generated");
    expect(JSON.parse(generated!.metadataJson ?? "{}")).toMatchObject({ usedEdit: true });
  });

  it("can recover one failed comic page through a targeted checkpoint job", async () => {
    let recover = false;
    const harness = await makeHarness({
      mock: {
        latencyMs: 1,
        shouldFailImage: (request) => !recover && request.prompt.includes("漫画页 2/4"),
      },
    });
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, {
      recipe: "comic_story",
      topic: "漫画检查点恢复",
    });

    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "failed", 20_000);
    const failed = (await harness.runRepo.listNodeRuns(runId)).find(
      (node) => node.nodeName === "generate-comic-pages" && node.status === "failed",
    );
    expect(JSON.parse(failed?.outputRef ?? "{}")).toMatchObject({ pageIndex: 1 });

    recover = true;
    await harness.runRepo.updateStatus(runId, "queued", { errorSummary: null });
    const retry = await harness.jobRepo.createOrReuse({
      kind: "comic_story_run",
      runId,
      idempotencyKey: `manual-comic-page:${runId}:1`,
      payloadJson: JSON.stringify({ mode: "page", targetPageIndex: 1, sourceRunId: runId }),
      maxAttempts: 3,
    });
    await waitUntil(async () => (await harness.runRepo.require(runId)).status === "succeeded", 20_000);
    await runner.stop();

    expect((await harness.jobRepo.require(retry.job.id)).status).toBe("succeeded");
    expect((await harness.assetRepo.listByRun(runId)).filter((asset) => asset.kind === "generated")).toHaveLength(4);
  });

});
