import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { knowledgeCardTheme } from "./theme";
import { fontsPresent } from "./fonts";
import { buildSlideTree, renderSlideDeterministic } from "./render";
import type { LayoutData, StoryboardSlide } from "@aai/shared-schemas";

/* 每种非 default 版式的确定性渲染兜底测试：渲染成功、PNG 合法、同输入同输出 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

const LAYOUT_CASES: Array<{ name: string; data: LayoutData }> = [
  {
    name: "big-number",
    data: {
      layout: "big-number",
      value: "93%",
      caption: "用户更信任标注来源的数据结论",
      source: "来源：示例行业报告 2025",
    },
  },
  {
    name: "timeline",
    data: {
      layout: "timeline",
      nodes: [
        { time: "2020", title: "概念提出", note: "学界首次系统提出" },
        { time: "2022", title: "工程化起步", note: "首个可用实现出现" },
        { time: "2025", title: "大规模落地", note: "主流厂商全面跟进" },
      ],
    },
  },
  {
    name: "table",
    data: {
      layout: "table",
      columns: ["维度", "方案A", "方案B"],
      rows: [
        ["价格", "低", "较高"],
        ["上手成本", "低", "中等"],
        ["生态成熟度", "一般", "成熟"],
        ["长期维护", "需自建", "厂商支持"],
      ],
    },
  },
  {
    name: "index",
    data: {
      layout: "index",
      items: [
        { title: "它到底是什么" },
        { title: "为什么重要" },
        { title: "怎么用起来" },
        { title: "常见误区" },
      ],
    },
  },
  {
    name: "quote",
    data: {
      layout: "quote",
      quote: "慢慢来，比较快。真正的积累从来不是一蹴而就的。",
      attribution: "——示例署名",
    },
  },
  {
    name: "process",
    data: {
      layout: "process",
      steps: [
        { title: "明确目标", note: "写下可衡量的结果" },
        { title: "拆解任务", note: "拆到一天能完成" },
        { title: "复盘迭代", note: "每周回顾一次" },
      ],
    },
  },
];

function slideWith(data: LayoutData): StoryboardSlide {
  return {
    index: 1,
    role: "content",
    headline: "版式样张标题",
    body: [],
    visualIntent: "版式样张（纯排版）",
    layoutHint: "样张",
    layout: data.layout,
    layoutData: data,
  };
}

function renderLayout(data: LayoutData, aspectRatio: "3:4" | "16:9" = "3:4") {
  return renderSlideDeterministic({
    theme: knowledgeCardTheme,
    aspectRatio,
    slide: slideWith(data),
    pageCount: 4,
  });
}

describe.skipIf(!fontsPresent())("layout slides (needs fonts)", () => {
  it.each(LAYOUT_CASES.map((testCase) => [testCase.name, testCase.data] as const))(
    "%s renders a valid PNG with correct dimensions",
    async (_name, data) => {
      const buffer = await renderLayout(data);
      // PNG 魔数
      expect([...buffer.subarray(0, 4)]).toEqual(PNG_MAGIC);
      const meta = await sharp(buffer).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBe(1242);
      expect(meta.height).toBe(1656);
    },
  );

  it.each(LAYOUT_CASES.map((testCase) => [testCase.name, testCase.data] as const))(
    "%s is byte-identical for identical input",
    async (_name, data) => {
      const a = await renderLayout(data);
      const b = await renderLayout(data);
      expect(a.equals(b)).toBe(true);
    },
  );

  it.each(LAYOUT_CASES.map((testCase) => [testCase.name, testCase.data] as const))(
    "%s renders deterministically on 16:9 canvas",
    async (_name, data) => {
      const a = await renderLayout(data, "16:9");
      const b = await renderLayout(data, "16:9");
      expect(a.equals(b)).toBe(true);
      const meta = await sharp(a).metadata();
      expect(meta.width).toBe(1920);
      expect(meta.height).toBe(1080);
    },
  );

  it.each(LAYOUT_CASES.map((testCase) => [testCase.name, testCase.data] as const))(
    "%s output changes when palette overrides differ",
    async (_name, data) => {
      const base = await renderLayout(data);
      const overridden = await renderSlideDeterministic({
        theme: knowledgeCardTheme,
        aspectRatio: "3:4",
        slide: slideWith(data),
        pageCount: 4,
        brand: { paletteJson: { primary: "#00ff88", background: "#101018" } },
      });
      expect(overridden.equals(base)).toBe(false);
    },
  );

  it("keeps legacy behavior when a visual layer is present (layout ignored)", async () => {
    const visual = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png()
      .toBuffer();
    const base64 = visual.toString("base64");
    const withLayout = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide: slideWith(LAYOUT_CASES[0]!.data),
      pageCount: 4,
      visualImageBase64: base64,
    });
    const legacySlide = { ...slideWith(LAYOUT_CASES[0]!.data) };
    delete legacySlide.layout;
    delete legacySlide.layoutData;
    const legacy = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide: legacySlide,
      pageCount: 4,
      visualImageBase64: base64,
    });
    expect(withLayout.equals(legacy)).toBe(true);
  });
});

describe("layout fallbacks (tree level, no fonts needed)", () => {
  it("renders a layout slide without layoutData as default (no throw)", async () => {
    if (!fontsPresent()) return; // 渲染需要字体
    const slide: StoryboardSlide = { ...slideWith(LAYOUT_CASES[0]!.data) };
    delete slide.layoutData;
    const buffer = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 4,
    });
    expect([...buffer.subarray(0, 4)]).toEqual(PNG_MAGIC);
  });

  it("renders a layout slide with mismatched layoutData as default (no throw)", async () => {
    if (!fontsPresent()) return;
    const slide: StoryboardSlide = {
      ...slideWith({
        layout: "timeline",
        nodes: [
          { title: "a" },
          { title: "b" },
          { title: "c" },
        ],
      }),
      layoutData: { layout: "big-number", value: "3", caption: "错配的数据形状" } as never,
    };
    const buffer = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 4,
    });
    expect([...buffer.subarray(0, 4)]).toEqual(PNG_MAGIC);
  });

  it("buildSlideTree is deterministic for layout slides", () => {
    const input = {
      theme: knowledgeCardTheme,
      aspectRatio: "3:4" as const,
      slide: slideWith(LAYOUT_CASES[4]!.data),
      pageCount: 4,
    };
    expect(JSON.stringify(buildSlideTree(input))).toBe(JSON.stringify(buildSlideTree(input)));
  });
});
