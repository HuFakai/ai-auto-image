import { describe, expect, it } from "vitest";
import { createMockProvider, extractContext } from "./index";
import { ContentBriefSchema, StoryboardSchema } from "@aai/shared-schemas";

describe("extractContext", () => {
  it("parses the field-line prompt format", () => {
    const ctx = extractContext(
      ["主题：量子纠缠", "画布比例：9:16", "目标平台：douyin", "标题：什么是纠缠"].join("\n"),
    );
    expect(ctx.topic).toBe("量子纠缠");
    expect(ctx.aspectRatio).toBe("9:16");
    expect(ctx.platform).toBe("douyin");
    expect(ctx.headline).toBe("什么是纠缠");
  });

  it("falls back to a placeholder topic", () => {
    expect(extractContext("没有字段的 prompt").topic).toBe("Mock 主题");
  });
});

describe("mock provider defaults", () => {
  it("produces schema-valid brief and storyboard objects", async () => {
    const { bundle } = createMockProvider();
    const brief = await bundle.text!.generateObject({
      prompt: "主题：火星种植\n画布比例：3:4\n目标平台：xiaohongshu",
      schemaName: "ContentBrief",
      schema: ContentBriefSchema,
    });
    expect(brief.topic).toBe("火星种植");

    const storyboard = await bundle.text!.generateObject({
      prompt: "主题：火星种植\n画布比例：9:16\n目标平台：douyin",
      schemaName: "Storyboard",
      schema: StoryboardSchema,
    });
    expect(storyboard.aspectRatio).toBe("9:16");
    expect(storyboard.platform).toBe("douyin");
    expect(storyboard.slides.length).toBeGreaterThanOrEqual(4);
  });

  it("renders placeholder images as PNG buffers", async () => {
    const { bundle } = createMockProvider();
    const images = await bundle.image!.generate({
      prompt: "主题：测试\n标题：封面页\n页码：1/4",
      aspectRatio: "3:4",
    });
    expect(images).toHaveLength(1);
    expect(images[0]?.source).toBe("base64");
    expect(images[0]?.usage?.images).toBe(1);
  });
});
