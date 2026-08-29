import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { knowledgeCardTheme } from "./theme";
import { fontsPresent, serifAvailable } from "./fonts";
import { buildSlideTree, renderSlideDeterministic } from "./render";
import { applyBrandOverlays, shrinkTextToFit } from "./brand-overlays";
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

  it("renders valid PNGs for very long signatures and corner watermarks (no overflow throw)", async () => {
    const base = await sampleImage();
    const longSignature = await applyBrandOverlays(base, {
      footerSignature: "@非常非常非常非常非常非常非常非常非常长的账号签名",
      watermarkText: "极其极其极其极其极其极其极其极其极其极其长的水印文字",
      watermarkPosition: "corner",
    });
    const meta = await sharp(longSignature).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(300);
  });
});

describe("shrinkTextToFit", () => {
  it("keeps short text unchanged at start size", () => {
    expect(shrinkTextToFit("短签名", 32, 12, 1000)).toEqual({ text: "短签名", fontSize: 32 });
  });

  it("reduces font size until it fits without truncating", () => {
    const fit = shrinkTextToFit("超".repeat(40), 32, 12, 640);
    expect(fit.text).toBe("超".repeat(40));
    expect(fit.fontSize).toBeLessThan(32);
  });

  it("truncates with ellipsis when the text cannot fit at minimum size", () => {
    const fit = shrinkTextToFit("超".repeat(200), 32, 12, 300);
    expect(fit.text.endsWith("…")).toBe(true);
    expect(fit.text.length).toBeLessThan(200);
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
    // 仅当 Serif 字体实际可用时才断言 serif 与 sans 渲染不同（缺失时 serif 回退 Sans）
    if (serifAvailable()) {
      expect(serif.equals(sans)).toBe(false);
    }
  });

  it("titleFont 只作用于 headline 元素，封面正文保持默认字体", () => {
    // 遍历布局树收集所有 fontFamily；big-center 下只有 headline 带 titleFont
    const collect = (node: unknown, acc: string[] = []): string[] => {
      if (!node || typeof node !== "object") return acc;
      const obj = node as { type?: unknown; props?: { style?: Record<string, unknown>; children?: unknown } };
      const style = obj.props?.style;
      if (style && typeof style.fontFamily === "string") acc.push(style.fontFamily);
      if (Array.isArray(obj.props?.children)) {
        for (const child of obj.props.children) collect(child, acc);
      } else if (obj.props?.children && typeof obj.props.children === "object") {
        collect(obj.props.children, acc);
      }
      return acc;
    };
    const tree = buildSlideTree({
      theme: knowledgeCardTheme,
      aspectRatio: "3:4",
      slide,
      pageCount: 1,
      brand: { titleFont: "serif", coverLayout: "big-center" },
    });
    const expected = serifAvailable() ? "Noto Serif SC" : "Noto Sans SC";
    expect(collect(tree)).toEqual([expected]);
  });
});
