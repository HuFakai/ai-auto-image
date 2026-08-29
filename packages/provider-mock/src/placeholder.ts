import sharp from "sharp";
import { CANVAS_SIZES, type AspectRatio } from "@aai/shared-schemas";

const escapeXml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Mock Provider 的占位图：按画布比例渲染一张深底琥珀字的"图卡"，
 * 让 Studio 演示画廊里的 Mock 结果看起来像真实页面。
 */
export async function renderPlaceholderImage(input: {
  aspectRatio: AspectRatio;
  title: string;
  subtitle?: string;
  pageIndex: number;
  pageCount: number;
}): Promise<Buffer> {
  const { width, height } = CANVAS_SIZES[input.aspectRatio];
  const title = escapeXml(input.title.slice(0, 18));
  const subtitle = escapeXml((input.subtitle ?? "").slice(0, 40));
  const pageLabel = escapeXml(`${input.pageIndex + 1} / ${input.pageCount}`);

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="30%" cy="20%" r="120%">
      <stop offset="0%" stop-color="#1c1c22"/>
      <stop offset="100%" stop-color="#0e0e10"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="48" y="48" width="${width - 96}" height="${height - 96}" fill="none" stroke="#3a3a42" stroke-width="2"/>
  <circle cx="${width - 120}" cy="120" r="10" fill="#f5a524"/>
  <text x="96" y="${height - 96}" font-family="sans-serif" font-size="34" fill="#8a8a94">${pageLabel}</text>
  <text x="96" y="${height / 2 - 20}" font-family="serif" font-size="88" font-weight="bold" fill="#f4f1ea">${title}</text>
  ${subtitle ? `<text x="96" y="${height / 2 + 60}" font-family="sans-serif" font-size="44" fill="#b9b4a8">${subtitle}</text>` : ""}
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
