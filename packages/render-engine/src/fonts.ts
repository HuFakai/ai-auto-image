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

/** 标题衬线字体（Brand Kit titleFont=serif 时切换；`pnpm fonts` 一并下载） */
const SERIF_FONT_FILES: Array<{ file: string; weight: 400 | 700 }> = [
  { file: "NotoSerifSC-Regular.otf", weight: 400 },
  { file: "NotoSerifSC-Bold.otf", weight: 700 },
];

export function fontsDir(): string {
  return FONTS_DIR;
}

/** Sans 主字体是否齐备（确定性渲染的硬性要求） */
export function fontsPresent(): boolean {
  return FONT_FILES.every((entry) => fs.existsSync(path.join(FONTS_DIR, entry.file)));
}

/** 衬线标题字体是否可用（titleFont=serif 时为可选；缺失时渲染回退 Sans） */
export function serifAvailable(): boolean {
  return SERIF_FONT_FILES.every((entry) => fs.existsSync(path.join(FONTS_DIR, entry.file)));
}

function loadFiles(
  files: Array<{ file: string; weight: 400 | 700 }>,
  family: string,
): LoadedFont[] {
  return files.map((entry) => ({
    name: family,
    data: fs.readFileSync(path.join(FONTS_DIR, entry.file)),
    weight: entry.weight,
    style: "normal" as const,
  }));
}

let serifMissingWarned = false;

/**
 * 加载中文字体（Noto Sans SC 必需 + Noto Serif SC 可选，OFL 许可）。
 * 字体不进 Git，运行 `pnpm fonts` 下载；Sans 缺失时给出明确指引而不是神秘报错。
 * Serif 缺失不阻断渲染：titleFont=serif 请求时回退用 Sans 渲染，仅 warn 一次。
 */
export function loadCardFonts(): LoadedFont[] {
  if (!fontsPresent()) {
    throw new Error(
      `Chinese fonts not found in ${FONTS_DIR}. Run "pnpm fonts" to download Noto Sans SC + Noto Serif SC (OFL).`,
    );
  }
  const sans = loadFiles(FONT_FILES, "Noto Sans SC");
  if (!serifAvailable()) {
    if (!serifMissingWarned) {
      console.warn(
        `Noto Serif SC not found in ${FONTS_DIR}; titleFont=serif will render with Noto Sans SC. Run "pnpm fonts" to download Serif fonts.`,
      );
      serifMissingWarned = true;
    }
    return sans;
  }
  return [...sans, ...loadFiles(SERIF_FONT_FILES, "Noto Serif SC")];
}
