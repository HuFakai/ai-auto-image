import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LoadedFont {
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: "normal";
}

const FONTS_DIR = process.env.FONT_DIR
  ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");

const FONT_FILES: Array<{ file: string; weight: 400 | 700 }> = [
  { file: "NotoSansSC-Regular.otf", weight: 400 },
  { file: "NotoSansSC-Bold.otf", weight: 700 },
];

export function fontsDir(): string {
  return FONTS_DIR;
}

export function fontsPresent(): boolean {
  return FONT_FILES.every((entry) => fs.existsSync(path.join(FONTS_DIR, entry.file)));
}

/**
 * 加载中文字体（Noto Sans SC，OFL 许可）。
 * 字体不进 Git，运行 `pnpm fonts` 下载；缺失时给出明确指引而不是神秘报错。
 */
export function loadCardFonts(): LoadedFont[] {
  if (!fontsPresent()) {
    throw new Error(
      `Chinese fonts not found in ${FONTS_DIR}. Run "pnpm fonts" to download Noto Sans SC (OFL).`,
    );
  }
  return FONT_FILES.map((entry) => ({
    name: "Noto Sans SC",
    data: fs.readFileSync(path.join(FONTS_DIR, entry.file)),
    weight: entry.weight,
    style: "normal" as const,
  }));
}
