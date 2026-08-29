import sharp from "sharp";
import type { PaletteOverrides } from "@aai/shared-schemas";

/**
 * Brand Kit 水印/签名叠加层。
 * 只依赖系统默认 sans 字体（SVG font-family="sans-serif"，librsvg 解析时无需字体文件），
 * 避免为几十 KB 的文字引入字体加载复杂度。
 */

export interface BrandOverlayConfig {
  footerSignature?: string | null | undefined;
  watermarkText?: string | null | undefined;
  watermarkPosition?: "corner" | "center" | undefined;
  watermarkOpacity?: number | undefined;
  paletteJson?: PaletteOverrides | null | undefined;
}

/** 水印/签名是否存在任一配置（无配置时 applyBrandOverlays 原样返回） */
export function hasBrandOverlays(
  brand: Pick<BrandOverlayConfig, "footerSignature" | "watermarkText"> | undefined | null,
): boolean {
  return Boolean(
    brand && (brand.footerSignature?.trim() || brand.watermarkText?.trim()),
  );
}

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return ch;
    }
  });
}

/** 文本宽度估算：CJK ≈ 1em，ASCII ≈ 0.55em（与 render.ts 同一套口径） */
function textUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    units += char.charCodeAt(0) > 0x2e7f ? 1 : 0.55;
  }
  return units;
}

/**
 * 把文本收缩到 maxWidth 内：先降字号（下限 minSize），
 * 达到最小字号仍溢出时逐字截断并补省略号，保证最终宽度 ≤ maxWidth。
 */
export function shrinkTextToFit(
  text: string,
  startSize: number,
  minSize: number,
  maxWidth: number,
): { text: string; fontSize: number } {
  let fontSize = startSize;
  while (fontSize > minSize && textUnits(text) * fontSize > maxWidth) {
    fontSize = Math.round(fontSize * 0.9);
  }
  let clipped = text;
  while (clipped.length > 0 && textUnits(clipped) * fontSize > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  if (clipped.length < text.length) {
    // 截断：预留省略号位置（约 1 字符宽），保证最终宽度不越界
    let withEllipsis = `${clipped.slice(0, -1)}…`;
    while (withEllipsis.length > 1 && textUnits(withEllipsis) * fontSize > maxWidth) {
      withEllipsis = `${withEllipsis.slice(0, -2)}…`;
    }
    return { text: withEllipsis, fontSize };
  }
  return { text, fontSize };
}

function clampOpacity(opacity: number | undefined): number {
  const value = opacity ?? 0.18;
  return Math.max(0, Math.min(1, value));
}

function buildOverlaySvg(width: number, height: number, brand: BrandOverlayConfig): string {
  const parts: string[] = [];
  const watermark = brand.watermarkText?.trim();
  const signature = brand.footerSignature?.trim();
  // 水印/签名默认取色板主色；未配置时用中性灰，保证浅色/深色背景都可见
  const baseColor = brand.paletteJson?.primary ?? brand.paletteJson?.accent ?? "#555555";

  if (signature) {
    // 页脚签名：超长时与 center 水印同样收缩（降字号→截断+省略号），保证不越界
    const fit = shrinkTextToFit(signature, Math.max(16, Math.round(width * 0.026)), 12, width * 0.92);
    const y = Math.round(height * 0.955);
    parts.push(
      `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="sans-serif" font-size="${fit.fontSize}" fill="${baseColor}" opacity="0.8">${escapeXml(fit.text)}</text>`,
    );
  }

  if (watermark) {
    const opacity = clampOpacity(brand.watermarkOpacity);
    const position = brand.watermarkPosition ?? "corner";
    if (position === "center") {
      // 居中大字，平铺一次；超长时按画布宽度收缩
      let fontSize = Math.round(width * 0.13);
      const maxWidth = width * 0.92;
      while (fontSize > 24 && textUnits(watermark) * fontSize > maxWidth) {
        fontSize = Math.round(fontSize * 0.9);
      }
      const x = width / 2;
      const y = Math.round(height / 2);
      parts.push(
        `<text x="${x}" y="${y}" dy="0.35em" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" fill="${baseColor}" opacity="${opacity}">${escapeXml(watermark)}</text>`,
      );
    } else {
      // corner：右下角斜置小字；超长时收缩（斜置后水平投影 ≈ 0.9×文本宽，
      // maxWidth 按画布宽度估算），保证不越界
      const fit = shrinkTextToFit(watermark, Math.max(14, Math.round(width * 0.024)), 10, width * 0.85);
      const x = Math.round(width * 0.955);
      const y = Math.round(height * 0.945);
      parts.push(
        `<text x="${x}" y="${y}" text-anchor="end" transform="rotate(-25 ${x} ${y})" font-family="sans-serif" font-size="${fit.fontSize}" fill="${baseColor}" opacity="${opacity}">${escapeXml(fit.text)}</text>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

/**
 * 在成品图上叠加 Brand Kit 页脚签名与水印。
 * 没有任何水印/签名配置（或 brand 缺省）时原样返回原 buffer（逐字节一致，零额外解码开销）。
 */
export async function applyBrandOverlays(
  buffer: Buffer,
  brand: BrandOverlayConfig | undefined | null,
): Promise<Buffer> {
  if (!brand || !hasBrandOverlays(brand)) return buffer;
  const meta = await sharp(buffer).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) return buffer;
  const svg = Buffer.from(buildOverlaySvg(width, height, brand));
  return sharp(buffer).composite([{ input: svg }]).png().toBuffer();
}
