import { describe, expect, it } from "vitest";
import {
  CANVAS_SIZES,
  ContentBriefSchema,
  CreateRunInputSchema,
  StoryboardSchema,
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
    expect(() => ContentBriefSchema.parse({ ...brief, objective: "viral" })).toThrow();
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

  it("keeps legacy layout metadata out of the runtime storyboard", () => {
    const parsed = StoryboardSchema.parse({
      title: "t",
      platform: "xiaohongshu",
      aspectRatio: "3:4",
      slides: [
        {
          index: 0,
          role: "cover",
          headline: "标题",
          body: [],
          visualIntent: "插画",
          layoutHint: "居中",
          layout: "big-number",
          layoutData: { value: "3" },
        },
      ],
    });
    expect(parsed.slides[0]).not.toHaveProperty("layout");
    expect(parsed.slides[0]).not.toHaveProperty("layoutData");
  });
});

describe("CreateRunInputSchema defaults", () => {
  it("fills platform and ratio defaults without a text-rendering mode", () => {
    const parsed = CreateRunInputSchema.parse({ topic: " hello " });
    expect(parsed.platform).toBe("xiaohongshu");
    expect(parsed.aspectRatio).toBe("3:4");
    expect(parsed).not.toHaveProperty("textRenderingMode");
  });
});

describe("CANVAS_SIZES", () => {
  it("uses 1242x1656 for 3:4", () => {
    expect(CANVAS_SIZES["3:4"]).toEqual({ width: 1242, height: 1656 });
  });
});
