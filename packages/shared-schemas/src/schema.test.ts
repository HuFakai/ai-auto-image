import { describe, expect, it } from "vitest";
import {
  CANVAS_SIZES,
  ContentBriefSchema,
  CreateRunInputSchema,
  LayoutDataSchema,
  StoryboardSchema,
  StoryboardSlideSchema,
  effectiveImageConcurrency,
  normalizeSlideLayout,
  resolveSlideLayout,
  type StoryboardSlide,
} from "./index";

const brief = {
  topic: "量子纠缠",
  audience: "科普爱好者",
  objective: "educate",
  coreMessage: "纠缠是相关性而非超距传信",
  evidence: [{ claim: "贝尔不等式实验", confidence: "verified" }],
  tone: ["严谨", "通俗"],
  prohibitedClaims: ["瞬间传信"],
};

describe("ContentBriefSchema", () => {
  it("accepts a valid brief", () => {
    const parsed = ContentBriefSchema.parse(brief);
    expect(parsed.topic).toBe("量子纠缠");
  });

  it("rejects unknown objective", () => {
    expect(() =>
      ContentBriefSchema.parse({ ...brief, objective: "viral" }),
    ).toThrow();
  });
});

describe("StoryboardSchema", () => {
  it("caps slides at 12", () => {
    const slide = {
      index: 0,
      role: "cover",
      headline: "标题",
      body: [],
      visualIntent: "插画",
      layoutHint: "居中",
    };
    const slides = Array.from({ length: 13 }, (_, i) => ({ ...slide, index: i }));
    expect(() =>
      StoryboardSchema.parse({
        title: "t",
        platform: "xiaohongshu",
        aspectRatio: "3:4",
        slides,
      }),
    ).toThrow();
  });
});

describe("CreateRunInputSchema defaults", () => {
  it("fills platform/ratio/mode/concurrency defaults", () => {
    const parsed = CreateRunInputSchema.parse({ topic: " hello " });
    expect(parsed.platform).toBe("xiaohongshu");
    expect(parsed.aspectRatio).toBe("3:4");
    expect(parsed.textRenderingMode).toBe("native");
    expect(parsed.requestedImageConcurrency).toBe(1);
  });
});

describe("effectiveImageConcurrency", () => {
  it("takes the minimum of all limits", () => {
    expect(effectiveImageConcurrency({ requested: 8, serverMax: 4 })).toBe(4);
    expect(effectiveImageConcurrency({ requested: 2, serverMax: 4, providerMax: 3 })).toBe(2);
    expect(effectiveImageConcurrency({ requested: 4, serverMax: 2, providerMax: 8 })).toBe(2);
  });
});

describe("CANVAS_SIZES", () => {
  it("uses 1242x1656 for 3:4", () => {
    expect(CANVAS_SIZES["3:4"]).toEqual({ width: 1242, height: 1656 });
  });
});

/* ── 版式路由：LayoutHint / LayoutData discriminated union ────────────────── */

const baseSlide = {
  index: 1,
  role: "content" as const,
  headline: "标题",
  body: [],
  visualIntent: "插画",
  layoutHint: "样张",
};

describe("LayoutDataSchema (discriminated union)", () => {
  it("accepts each valid layout data shape", () => {
    expect(
      LayoutDataSchema.parse({
        layout: "big-number",
        value: "93%",
        caption: "用户更信任标注来源的数据",
        source: "来源：示例报告",
      }),
    ).toMatchObject({ layout: "big-number" });
    expect(
      LayoutDataSchema.parse({
        layout: "timeline",
        nodes: [
          { time: "2020", title: "起步" },
          { title: "加速", note: "工程化" },
          { time: "2025", title: "成熟" },
        ],
      }),
    ).toMatchObject({ layout: "timeline" });
    expect(
      LayoutDataSchema.parse({
        layout: "table",
        columns: ["维度", "A", "B"],
        rows: [
          ["价格", "低", "高"],
          ["上手", "快", "慢"],
        ],
      }),
    ).toMatchObject({ layout: "table" });
    expect(
      LayoutDataSchema.parse({
        layout: "index",
        items: [{ title: "它是什么" }, { title: "怎么用" }],
      }),
    ).toMatchObject({ layout: "index" });
    expect(
      LayoutDataSchema.parse({ layout: "quote", quote: "慢慢来，比较快。", attribution: "——佚名" }),
    ).toMatchObject({ layout: "quote" });
    expect(
      LayoutDataSchema.parse({
        layout: "process",
        steps: [
          { title: "明确目标" },
          { title: "拆解任务", note: "拆到一天能完成" },
        ],
      }),
    ).toMatchObject({ layout: "process" });
  });

  it("rejects unknown layout discriminator and wrong shapes", () => {
    expect(() => LayoutDataSchema.parse({ layout: "cards", items: [] })).toThrow();
    expect(() =>
      LayoutDataSchema.parse({ layout: "big-number", value: "93%" }), // 缺 caption
    ).toThrow();
    expect(() =>
      LayoutDataSchema.parse({
        layout: "timeline",
        nodes: [{ title: "a" }, { title: "b" }], // 少于 3 个节点
      }),
    ).toThrow();
    expect(() =>
      LayoutDataSchema.parse({
        layout: "table",
        columns: ["维度", "A"],
        rows: [["价格", "低"], ["上手", "快", "慢"]], // 行长度与列数不一致
      }),
    ).toThrow();
    expect(() =>
      LayoutDataSchema.parse({
        layout: "index",
        items: [{ title: "只有一项" }], // 少于 2 项
      }),
    ).toThrow();
    expect(() => LayoutDataSchema.parse({ layout: "quote", quote: "太短" })).toThrow();
    expect(() =>
      LayoutDataSchema.parse({ layout: "process", steps: [{ title: "唯一一步" }] }),
    ).toThrow();
  });

  it("rejects cells and fields over the length caps", () => {
    expect(() =>
      LayoutDataSchema.parse({
        layout: "big-number",
        value: "1".repeat(13), // >12
        caption: "ok",
      }),
    ).toThrow();
    expect(() =>
      LayoutDataSchema.parse({
        layout: "table",
        columns: ["维度", "A"],
        rows: [["x".repeat(41), "ok"]], // 单元格 >40 字
      }),
    ).toThrow();
  });

  it("StoryboardSlideSchema keeps layout fields lenient (parse never throws; pipeline normalizes)", () => {
    const parsed = StoryboardSlideSchema.parse({
      ...baseSlide,
      layout: "cards",
      layoutData: { weird: true },
    });
    expect(parsed.layout).toBe("cards");
    // 旧分镜无这两个字段照常工作
    const legacy = StoryboardSlideSchema.parse(baseSlide);
    expect(legacy.layout).toBeUndefined();
    expect(legacy.layoutData).toBeUndefined();
  });
});

describe("layout normalization helpers", () => {
  it("resolveSlideLayout accepts a valid hint + matching data", () => {
    const resolved = resolveSlideLayout({
      layout: "big-number",
      layoutData: { layout: "big-number", value: "3", caption: "三个关键判断" },
    });
    expect(resolved.layout).toBe("big-number");
    expect(resolved.layoutData?.layout).toBe("big-number");
  });

  it("resolveSlideLayout falls back to default on mismatch or invalid data", () => {
    expect(resolveSlideLayout({ layout: "timeline", layoutData: undefined }).layout).toBe("default");
    expect(
      resolveSlideLayout({
        layout: "timeline",
        layoutData: { layout: "big-number", value: "3", caption: "错配" },
      }).layout,
    ).toBe("default");
    expect(
      resolveSlideLayout({
        layout: "quote",
        layoutData: { layout: "quote", quote: "太短" }, // 非法：引文过短
      }).layout,
    ).toBe("default");
    expect(resolveSlideLayout({ layout: "cards" }).layout).toBe("default"); // 未知 hint
    expect(resolveSlideLayout({ layout: "default" }).layout).toBe("default");
  });

  it("normalizeSlideLayout deletes fields when invalid and keeps them when valid", () => {
    const invalid: StoryboardSlide = StoryboardSlideSchema.parse({
      ...baseSlide,
      layout: "table",
      layoutData: { layout: "quote", quote: "完全错配的数据形状" },
    });
    normalizeSlideLayout(invalid);
    expect(invalid.layout).toBeUndefined();
    expect(invalid.layoutData).toBeUndefined();

    const valid: StoryboardSlide = StoryboardSlideSchema.parse({
      ...baseSlide,
      layout: "process",
      layoutData: {
        layout: "process",
        steps: [
          { title: "明确目标" },
          { title: "拆解任务" },
          { title: "复盘迭代" },
        ],
      },
    });
    normalizeSlideLayout(valid);
    expect(valid.layout).toBe("process");
    expect(valid.layoutData).toMatchObject({ layout: "process" });

    // 无字段的旧分镜原样保留
    const legacy: StoryboardSlide = StoryboardSlideSchema.parse(baseSlide);
    normalizeSlideLayout(legacy);
    expect(legacy.layout).toBeUndefined();
  });
});
