import { afterAll, describe, expect, it } from "vitest";
import { CreateRunInputSchema, type ContentBrief, type CreateRunInput } from "@aai/shared-schemas";
import { buildBriefPrompt, buildComicStoryboardPrompt, buildSlidePrompt, buildStoryboardPrompt } from "./prompts";
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

const baseBrief: ContentBrief = {
  topic: "测试",
  audience: "大众",
  objective: "educate",
  coreMessage: "核心判断",
  evidence: [],
  tone: [],
  prohibitedClaims: [],
};

function storyboardPrompt(input: Partial<CreateRunInput> & { topic: string }): string {
  const parsed = CreateRunInputSchema.parse(input);
  return buildStoryboardPrompt(parsed, { ...baseBrief, topic: parsed.topic });
}

describe("recipe storyboard prompt branches", () => {
  it("quote_cards: 注入金句卡结构、页数与大字直出", () => {
    const p = storyboardPrompt({ recipe: "quote_cards", topic: "保持专注" });
    expect(p).toContain("金句卡");
    expect(p).toContain("4–6 句金句");
    expect(p).toContain("5–7 页");
    expect(p).toContain("大字直出");
  });

  it("checklist_cards: 注入清单结构、编号条目与行动号召尾页", () => {
    const p = storyboardPrompt({ recipe: "checklist_cards", topic: "露营清单" });
    expect(p).toContain("清单卡");
    expect(p).toContain("3–5 条编号条目");
    expect(p).toContain("行动号召尾页");
    expect(p).toContain("4–6 页");
  });

  it("comparison_cards: 注入对比对象 B", () => {
    const p = storyboardPrompt({ recipe: "comparison_cards", topic: "骑自行车", comparisonTarget: "坐地铁" });
    expect(p).toContain("对比卡");
    expect(p).toContain("对比对象 B：坐地铁");
    expect(p).toContain("对比维度页 3–5 页");
  });

  it("comparison_cards: 缺省对比对象时仍产出合理指令", () => {
    const p = storyboardPrompt({ recipe: "comparison_cards", topic: "通勤方式" });
    expect(p).toContain("对比对象 B：用户未指定");
    expect(p).toContain("合理、常见的对比对象");
  });

  it("product_showcase: 注入产品资料", () => {
    const p = storyboardPrompt({
      recipe: "product_showcase",
      topic: "咖啡机",
      productInfo: { name: "摩卡壶", audience: "租房白领", priceNote: "200 元档", sellingPoints: ["小巧", "出杯快"] },
    });
    expect(p).toContain("产品种草");
    expect(p).toContain("摩卡壶");
    expect(p).toContain("促单尾页");
  });

  it("product_showcase: sourceText 作为产品资料", () => {
    const p = storyboardPrompt({ recipe: "product_showcase", topic: "咖啡机", sourceText: "这是一款便携手冲壶…" });
    expect(p).toContain("sourceText 即为产品资料正文");
  });

  it("book_recommendations: 注入书目信息", () => {
    const p = storyboardPrompt({
      recipe: "book_recommendations",
      topic: "《置身事内》",
      bookInfo: { title: "置身事内", author: "兰小欢" },
    });
    expect(p).toContain("图书推荐");
    expect(p).toContain("置身事内");
    expect(p).toContain("兰小欢");
  });

  it("article_digest: 强调忠实原文、不得编造，页数 3–8", () => {
    const p = storyboardPrompt({
      recipe: "article_digest",
      topic: "复利思维",
      sourceText: "第一，复利需要时间。第二，收益率不是全部。",
    });
    expect(p).toContain("长文拆解");
    expect(p).toContain("不得编造");
    expect(p).toContain("忠实原文");
    expect(p).toContain("3–8 页");
  });

  it("knowledge_cards: 行为保持不变", () => {
    const p = storyboardPrompt({ topic: "量子纠缠" });
    expect(p).toContain("任务：生成 Storyboard（封面、正文、总结/CTA）。");
    expect(p).toContain("生成 4–6 页");
    expect(p).not.toContain("内容类型：");
  });
});

describe("recipe brief prompt branches", () => {
  it("quote_cards brief 提示金句卡，knowledge_cards 不变", () => {
    const quoteInput = CreateRunInputSchema.parse({ recipe: "quote_cards", topic: "专注" });
    expect(buildBriefPrompt(quoteInput)).toContain("金句卡");
    const kcInput = CreateRunInputSchema.parse({ topic: "量子纠缠" });
    expect(buildBriefPrompt(kcInput)).not.toContain("内容类型：");
  });

  it("comparison_cards brief 注入对比对象，缺省时给出合理指令", () => {
    const withTarget = CreateRunInputSchema.parse({ recipe: "comparison_cards", topic: "iPhone", comparisonTarget: "Android" });
    expect(buildBriefPrompt(withTarget)).toContain("Android");
    const without = CreateRunInputSchema.parse({ recipe: "comparison_cards", topic: "通勤" });
    expect(buildBriefPrompt(without)).toContain("确定一个合理的对比对象");
  });
});

describe("quote_cards slide prompt", () => {
  it("native 模式强调金句大字直出", () => {
    const input = CreateRunInputSchema.parse({ recipe: "quote_cards", topic: "专注", platform: "xiaohongshu", aspectRatio: "3:4" });
    const storyboard = {
      title: "t",
      platform: "xiaohongshu" as const,
      aspectRatio: "3:4" as const,
      slides: [{ index: 0, role: "cover" as const, headline: "标题", body: [], visualIntent: "插画", layoutHint: "居中" }],
    };
    const plan = buildSlidePrompt(storyboard.slides[0]!, storyboard, input, "native");
    expect(plan.imagePrompt).toContain("金句为画面绝对主角");
  });
});

describe("comic storyboard prompt variants", () => {
  it("strip_comic: 四格漫画分镜变体（1–2 页、起承转合、对白精简）", () => {
    const input = CreateRunInputSchema.parse({ recipe: "strip_comic", topic: "没带伞的一天" });
    const p = buildComicStoryboardPrompt(
      input,
      { coreMessage: "出门前看天气" },
      "【小知】外貌：圆脸短发少年；服装：蓝色连帽衫",
    );
    expect(p).toContain("四格漫画");
    expect(p).toContain("1–2 页");
    expect(p).toContain("起承转合");
    expect(p).toContain("每格 0–1 条");
  });

  it("comic_story: 分镜指令保持原有文案", () => {
    const input = CreateRunInputSchema.parse({ recipe: "comic_story", topic: "复利" });
    const p = buildComicStoryboardPrompt(input, { coreMessage: "复利的威力" }, "cast");
    expect(p).toContain("3–6 页科普漫画分镜");
    expect(p).toContain("每页 1–3 条对白");
  });
});

describe("quote_cards pipeline (mock)", () => {
  it("runs end to end to succeeded via knowledge card pipeline", async () => {
    const harness = await makeHarness({ mock: { latencyMs: 1 } });
    const runner = startEvalRunner(harness);
    const { runId, jobId } = await createRunWith(harness, { recipe: "quote_cards", topic: "保持专注的金句" });

    await waitUntil(async () => (await harness.jobRepo.require(jobId)).status === "succeeded", 20_000);
    await runner.stop();

    expect((await harness.runRepo.require(runId)).status).toBe("succeeded");
    const assets = await harness.assetRepo.listByRun(runId);
    expect(assets.filter((a) => a.kind === "generated")).toHaveLength(4);
    expect(assets.find((a) => a.kind === "export-manifest")).toBeDefined();
  });
});
