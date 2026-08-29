import fs from "node:fs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  buildExportZip,
  templateCopy,
  generatePlatformCopy,
  type ExportPageFile,
} from "./export";
import { buildBriefPrompt, buildStoryboardPrompt, buildSlidePrompt } from "./prompts";
import { themeById } from "@aai/render-engine";
import {
  createHarness,
  createRunWith,
  startEvalRunner,
  waitUntil,
  type Harness,
} from "./testkit";
import { CreateRunInputSchema, type CreateRunInput } from "@aai/shared-schemas";

const harnesses: Harness[] = [];
async function makeHarness(options?: Parameters<typeof createHarness>[0]): Promise<Harness> {
  const harness = await createHarness(options);
  harnesses.push(harness);
  return harness;
}

async function runToSuccess(
  harness: Harness,
  input: Partial<CreateRunInput> & { topic: string },
): Promise<{ runId: string; jobId: string }> {
  const runner = startEvalRunner(harness);
  const { runId, jobId } = await createRunWith(harness, input);
  await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded", 20_000);
  await runner.stop();
  return { runId, jobId };
}

describe("iteration 2: page regen (Revision)", () => {
  it("regenerates a single page: old asset superseded, revision recorded, other pages untouched", async () => {
    const harness = await makeHarness({ mock: { latencyMs: 1 } });
    const { runId } = await runToSuccess(harness, { topic: "返修测试" });

    const before = new Map(
      (await harness.assetRepo.listByRun(runId))
        .filter((a) => a.kind === "generated")
        .map((a) => [a.pageIndex, a.id]),
    );

    // 单页返修：第 2 页换标题
    const runner = startEvalRunner(harness);
    const { job } = await harness.jobRepo.createOrReuse({
      kind: "page_regen",
      runId,
      idempotencyKey: `page_regen:${runId}:1:v1`,
      payloadJson: JSON.stringify({ pageIndex: 1, headline: "全新标题" }),
    });
    await waitUntil(async () => (await harness.jobRepo.require(job.id)).status === "succeeded", 15_000);
    await runner.stop();

    // 旧资产被替代，新资产成为当前版本
    const oldAsset = await harness.assetRepo.require(before.get(1)!);
    expect(oldAsset.supersededAt).not.toBeNull();
    const current = await harness.assetRepo.latestForPage(runId, 1);
    expect(current?.id).not.toBe(before.get(1));
    expect(JSON.parse(current?.metadataJson ?? "{}")).toMatchObject({ revision: 2 });

    // 其他页面不受影响
    for (const pageIndex of [0, 2, 3]) {
      expect((await harness.assetRepo.latestForPage(runId, pageIndex))?.id).toBe(before.get(pageIndex));
    }

    // Revision 版本链
    const revisions = await harness.revisionRepo.listByPage(runId, 1);
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(revisions[0]?.payloadJson ?? "{}")).toMatchObject({ pageIndex: 1, headline: "全新标题" });

    // 运行回到待审状态
    expect((await harness.runRepo.require(runId)).reviewStatus).toBe("pending");

    // 新文案已同步回 Storyboard（详情/导出与图片一致）
    const storyboardNode = (await harness.runRepo.listNodeRuns(runId)).find(
      (n) => n.nodeName === "generate-storyboard",
    );
    const storyboard = (JSON.parse(storyboardNode!.outputRef!) as { value: { slides: Array<{ headline: string }> } }).value;
    expect(storyboard.slides[1]?.headline).toBe("全新标题");
  });
});

describe("iteration 2: export ZIP", () => {
  it("builds a ZIP with ordered images, copy markdown, manifest and checklist", async () => {
    const harness = await makeHarness({ mock: { latencyMs: 1 } });
    const { runId } = await runToSuccess(harness, { topic: "ZIP 导出测试" });

    const pages: ExportPageFile[] = (await harness.assetRepo.listByRun(runId))
      .filter((a) => a.kind === "generated")
      .sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0))
      .map((a) => ({
        index: a.pageIndex ?? 0,
        role: `p${a.pageIndex}`,
        headline: `页${a.pageIndex}`,
        body: [],
        filename: a.filePath,
        buffer: fs.readFileSync(a.filePath),
      }));

    const input = CreateRunInputSchema.parse({ topic: "ZIP 导出测试" });
    const copy = templateCopy(input, pages, "核心判断");
    const zipBuffer = await buildExportZip({
      runId,
      topic: input.topic,
      storyboard: { title: "测试作品", platform: "xiaohongshu", aspectRatio: "3:4" },
      pages,
      copy,
      manifest: { runId, usage: await harness.runRepo.runTotals(runId) },
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const imageFiles = Object.keys(zip.files)
      .filter((name) => name.startsWith("images/") && !zip.files[name]!.dir)
      .sort();
    expect(imageFiles).toHaveLength(4);
    // 文件名序号即发布顺序（01 起始、连续递增）
    expect(imageFiles[0]).toMatch(/^images\/01-/);
    expect(imageFiles[3]).toMatch(/^images\/04-/);
    expect(zip.file("发布文案.md")).toBeTruthy();
    expect(zip.file("发布清单.txt")).toBeTruthy();
    const manifest = await zip.file("manifest.json")!.async("string");
    expect(JSON.parse(manifest)).toMatchObject({ runId });
    const copyMd = await zip.file("发布文案.md")!.async("string");
    expect(copyMd).toContain(copy.title);
  });

  it("generates platform copy through the text model when available", async () => {
    const harness = await makeHarness({ mock: { latencyMs: 1 } });
    const input = CreateRunInputSchema.parse({ topic: "文案生成" });
    const copy = await generatePlatformCopy(harness.mock.bundle.text!, input, [
      { index: 0, role: "cover", headline: "封面", body: [], filename: "a.png", buffer: Buffer.alloc(0) },
    ]);
    expect(copy.source).toBe("llm");
    expect(copy.title.length).toBeLessThanOrEqual(20);
    expect(copy.tags.length).toBeGreaterThanOrEqual(1);
    // 降级路径始终可用
    const fallback = templateCopy(input, [], "核心判断");
    expect(fallback.source).toBe("template");
    expect(fallback.title.length).toBeLessThanOrEqual(20);
  });
});

describe("iteration 2: density pagination & brand style prompts", () => {
  const input = CreateRunInputSchema.parse({
    topic: "长文拆解",
    sourceText: "第一，复利需要时间。第二，收益率不是全部。第三，坚持定投。",
    brandKit: { themeId: "paper_minimal", styleKeywords: ["水彩插画"], negativeKeywords: ["真人照片"] },
  });

  it("injects source material and density rules into the storyboard prompt", () => {
    const prompt = buildStoryboardPrompt(input, {
      topic: input.topic,
      audience: "大众",
      objective: "educate",
      coreMessage: "核心",
      evidence: [],
      tone: [],
      prohibitedClaims: [],
    });
    expect(prompt).toContain("分页密度约束");
    expect(prompt).toContain("6–10 页");
    expect(prompt).toContain("<<<资料开始>>>");
    expect(prompt).toContain("复利需要时间");
  });

  it("passes source material to the brief prompt and forbids fabrication", () => {
    const briefPrompt = buildBriefPrompt(input);
    expect(briefPrompt).toContain("不得编造超出资料的事实");
    expect(briefPrompt).toContain("<<<资料开始>>>");
  });

  it("injects brand style keywords and negatives into slide prompts", () => {
    const storyboard = {
      title: "t",
      platform: "xiaohongshu" as const,
      aspectRatio: "3:4" as const,
      slides: [
        { index: 0, role: "cover" as const, headline: "标题", body: ["正文"], visualIntent: "插画", layoutHint: "居中" },
      ],
    };
    const nativePlan = buildSlidePrompt(storyboard.slides[0]!, storyboard, input, "native");
    expect(nativePlan.imagePrompt).toContain("水彩插画");
    expect(nativePlan.imagePrompt).toContain("真人照片");
    const detPlan = buildSlidePrompt(storyboard.slides[0]!, storyboard, input, "deterministic");
    expect(detPlan.imagePrompt).toContain("水彩插画");
  });

  it("falls back to the default theme for unknown theme ids", () => {
    expect(themeById("unknown").name).toBe("darkroom-knowledge");
    expect(themeById("paper_minimal").templateVersion).toBe("paper-minimal@1");
  });
});
