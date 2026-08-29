import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { knowledgeCardTheme } from "./theme";
import { fontsPresent } from "./fonts";
import { buildSlideTree, renderSlideDeterministic } from "./render";
import type { StoryboardSlide } from "@aai/shared-schemas";

const slide: StoryboardSlide = {
  index: 1,
  role: "content",
  headline: "量子纠缠是什么",
  body: ["两个粒子共享同一个量子态", "测量其中一个，另一个立即关联", "但它不能用来超光速传信"],
  visualIntent: "简洁示意插画",
  layoutHint: "上图下文",
};

describe.skipIf(!fontsPresent())("renderSlideDeterministic (needs fonts)", () => {
  it("renders a PNG with the right dimensions", async () => {
    const buffer = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 4,
    });
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(1242);
    expect(meta.height).toBe(1656);
    expect(meta.format).toBe("png");
  });

  it("is byte-identical for identical input", async () => {
    const a = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 4,
    });
    const b = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 4,
    });
    expect(a.equals(b)).toBe(true);
  });

  it("composites the visual layer when provided", async () => {
    // 生成一张 10x10 红色背景图作视觉层
    const visual = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png()
      .toBuffer();
    const buffer = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 4,
      visualImageBase64: visual.toString("base64"),
    });
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    // 覆盖层带暗色遮罩：中心像素不应是纯背景色 0x0e0e10
    const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
    expect(data[center]! + data[center + 1]! + data[center + 2]!).toBeGreaterThan(60);
  });
});

describe("buildSlideTree", () => {
  it("produces identical trees for identical input", () => {
    const a = JSON.stringify(buildSlideTree({ theme: knowledgeCardTheme, aspectRatio: "3:4", slide, pageCount: 4 }));
    const b = JSON.stringify(buildSlideTree({ theme: knowledgeCardTheme, aspectRatio: "3:4", slide, pageCount: 4 }));
    expect(a).toBe(b);
  });

  it("throws a diagnosable error when fonts are missing", async () => {
    if (fontsPresent()) return; // 字体存在时不测缺失分支
    const dir = path.join(os.tmpdir(), "no-fonts-check");
    fs.existsSync(dir);
    await expect(
      renderSlideDeterministic({ theme: knowledgeCardTheme, aspectRatio: "3:4", slide, pageCount: 4 }),
    ).rejects.toThrow(/pnpm fonts/);
  });
});
