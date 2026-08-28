import { readFile } from "node:fs/promises";
import path from "node:path";
import satori from "satori";
import sharp from "sharp";

/** Satori element tree node (plain object form). */
export type SatoriElement = { type: string; props: Record<string, unknown> };

export interface FontEntry {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
}

let fontCache: FontEntry[] | null = null;

/**
 * Load CJK fonts once per process. Paths are configurable so the Docker
 * image can ship fonts at a fixed location.
 */
export async function loadFonts(opts: { regularPath?: string; boldPath?: string } = {}): Promise<FontEntry[]> {
  if (fontCache) return fontCache;
  // Resolution order: explicit opts → env → monorepo cwd fallback (Docker sets env).
  const regular =
    opts.regularPath ??
    process.env.FONT_REGULAR_PATH ??
    path.resolve(process.cwd(), "../../packages/render-engine/assets/fonts/NotoSansSC-Regular.otf");
  const bold =
    opts.boldPath ??
    process.env.FONT_BOLD_PATH ??
    path.resolve(process.cwd(), "../../packages/render-engine/assets/fonts/NotoSansSC-Bold.otf");
  const entries: FontEntry[] = [];
  try {
    entries.push({ name: "Noto Sans SC", data: await readFile(regular), weight: 400, style: "normal" });
    entries.push({ name: "Noto Sans SC", data: await readFile(bold), weight: 700, style: "normal" });
  } catch (err) {
    throw new Error(
      `CJK fonts not found (${regular}, ${bold}). Set FONT_REGULAR_PATH / FONT_BOLD_PATH or bundle fonts with the image.`
    );
  }
  fontCache = entries;
  return entries;
}

export function _resetFontCacheForTests(): void {
  fontCache = null;
}

/** Render a Satori element tree (plain object elements) into a PNG buffer. */
export async function renderSatoriToPng(
  element: SatoriElement,
  opts: { width: number; height: number; fonts?: FontEntry[] }
): Promise<Buffer> {
  const fonts = opts.fonts ?? (await loadFonts());
  const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
    width: opts.width,
    height: opts.height,
    fonts,
  });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export { sharp };
