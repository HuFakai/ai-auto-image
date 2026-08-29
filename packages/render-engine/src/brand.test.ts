import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { knowledgeCardTheme } from "./theme";
import { fontsPresent } from "./fonts";
import { renderSlideDeterministic } from "./render";
import { applyBrandOverlays } from "./brand-overlays";
import type { StoryboardSlide } from "@aai/shared-schemas";

const slide: StoryboardSlide = {
  index: 0,
  role: "cover",
  headline: "品牌样张标题",
  body: ["示例正文第一行", "示例正文第二行"],
  visualIntent: "示例",
  layoutHint: "cover",
};

/** 不含文本的纯色 PNG，用于叠加层测试（不依赖字体） */
async function sampleImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 200,
      height: 300,
      channels: 3,
      background: { r: 250, g: 247, b: 242 },
    },
  })
    .png()
    .toBuffer();
}

describe("applyBrandOverlays", () => {
  it("returns the original buffer byte-identical when nothing is configured", async () => {
    const base = await sampleImage();
    const out = await applyBrandOverlays(base, {});
    expect(out.equals(base)).toBe(true);
  });

  it("returns a different buffer when watermark/signature is configured", async () => {
    const base = await sampleImage();
    const corner = await applyBrandOverlays(base, { watermarkText: "示例水印" });
    expect(corner.equals(base)).toBe(false);

    const center = await applyBrandOverlays(base, {
      watermarkText: "示例水印",
      watermarkPosition: "center",
      watermarkOpacity: 0.3,
    });
    expect(center.equals(base)).toBe(false);

    const signature = await applyBrandOverlays(base, { footerSignature: "@示例账号" });
    expect(signature.equals(base)).toBe(false);
  });

  it("still produces a valid PNG of the same size", async () => {
    const base = await sampleImage();
    const out = await applyBrandOverlays(base, {
      watermarkText: "示例水印",
      footerSignature: "@示例账号",
    });
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(300);
  });
});

describe.skipIf(!fontsPresent())("brand render injection (needs fonts)", () => {
  it("keeps default output unchanged when brand is omitted", async () => {
    const a = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
    });
    const b = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
    });
    expect(a.equals(b)).toBe(true);
  });

  it("palette overrides change the deterministic output", async () => {
    const base = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
    });
    const overridden = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
      brand: {
        paletteJson: { primary: "#ff0000", background: "#111111", ink: "#ffffff" },
      },
    });
    expect(overridden.equals(base)).toBe(false);
  });

  it("different palettes produce different buffers", async () => {
    const a = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
      brand: { paletteJson: { primary: "#ff0000" } },
    });
    const b = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
      brand: { paletteJson: { primary: "#00ff00" } },
    });
    expect(a.equals(b)).toBe(false);
  });

  it("coverLayout variants render successfully and deterministically", async () => {
    for (const coverLayout of ["big-center", "split"] as const) {
      const a = await renderSlideDeterministic({
        theme: knowledgeCardTheme,
        aspectRatio: "3:4",
        slide,
        pageCount: 1,
        brand: { coverLayout },
      });
      const b = await renderSlideDeterministic({
        theme: knowledgeCardTheme,
        aspectRatio: "3:4",
        slide,
        pageCount: 1,
        brand: { coverLayout },
      });
      expect(a.equals(b)).toBe(true);
      const meta = await sharp(a).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBe(1242);
    }
  });

  it("applies overlays inside renderSlideDeterministic when brand configured", async () => {
    const base = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
    });
    const overlaid = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
      brand: { watermarkText: "样张水印", footerSignature: "@示例账号" },
    });
    expect(overlaid.equals(base)).toBe(false);
  });

  it("titleFont switches the cover title font and stays deterministic", async () => {
    const serif = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
      brand: { titleFont: "serif" },
    });
    const serifAgain = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
      brand: { titleFont: "serif" },
    });
    const sans = await renderSlideDeterministic({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
      brand: { titleFont: "sans" },
    });
    expect(serif.equals(serifAgain)).toBe(true);
    expect(serif.equals(sans)).toBe(false);
  });
});
