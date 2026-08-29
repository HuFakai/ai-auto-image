import { afterAll, describe, expect, it } from "vitest";
import { renderComicSlide, themeById } from "@aai/render-engine";
import sharp from "sharp";
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

  it("builds anchored page prompts with cast appearance and no-text rule", () => {
    const input = CreateRunInputSchema.parse({ recipe: "comic_story", topic: "复利" });
    const prompt = buildComicPagePrompt(input, storyboard, 0);
    expect(prompt).toContain("短发少年");
    expect(prompt).toContain("蓝帽衫");
    expect(prompt).toContain("绝对不要出现任何文字");
    expect(buildCharacterAnchorText(storyboard.cast)).toContain("禁止变化");
  });
});

describe("comic pipeline (mock, edit-capable route)", () => {
  it("runs end to end: cast → ref image → storyboard+checks → 4 pages → bubbles", async () => {
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

    // 合成页（画面 + 气泡）4 张，metadata 含对白
    const composites = (await harness.assetRepo.listByRun(runId)).filter((a) => a.kind === "composite");
    expect(composites).toHaveLength(4);
    const first = JSON.parse(composites[0]!.metadataJson ?? "{}") as { dialogues: unknown[] };
    expect(first.dialogues.length).toBeGreaterThanOrEqual(1);

    // Mock 渠道具备编辑能力 → 走图生图参考链
    const generated = (await harness.assetRepo.listByRun(runId)).find((a) => a.kind === "generated");
    expect(JSON.parse(generated!.metadataJson ?? "{}")).toMatchObject({ usedEdit: true });
  });
});

describe("renderComicSlide (needs fonts)", () => {
  it("composites panel with bubble overlay at canvas size", async () => {
    const { fontsPresent } = await import("@aai/render-engine");
    if (!fontsPresent()) return;

    const panel = await sharp({
      create: { width: 1242, height: 1656, channels: 3, background: { r: 90, g: 110, b: 140 } },
    })
      .png()
      .toBuffer();

    const buffer = await renderComicSlide({
      theme: themeById("darkroom"),
      aspectRatio: "3:4",
      panelImageBase64: panel.toString("base64"),
      title: "测试漫画",
      pageIndex: 1,
      pageCount: 4,
      dialogues: [
        { speaker: "旁白", text: "这是旁白说明一行字", type: "narration" },
        { speaker: "小知", text: "这是对白气泡的文字内容", type: "speech" },
      ],
    });
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(1242);
    expect(meta.height).toBe(1656);

    // 确定性：同输入同输出
    const buffer2 = await renderComicSlide({
      theme: themeById("darkroom"),
      aspectRatio: "3:4",
      panelImageBase64: panel.toString("base64"),
      title: "测试漫画",
      pageIndex: 1,
      pageCount: 4,
      dialogues: [
        { speaker: "旁白", text: "这是旁白说明一行字", type: "narration" },
        { speaker: "小知", text: "这是对白气泡的文字内容", type: "speech" },
      ],
    });
    expect(buffer.equals(buffer2)).toBe(true);
  });
});
