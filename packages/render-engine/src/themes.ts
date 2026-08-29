import type { PaletteOverrides } from "@aai/shared-schemas";

/** 知识卡片主题：六套内置预设（Brand Kit themeId 与 THEME_IDS 对应） */
export interface CardTheme {
  name: string;
  version: number;
  colors: {
    background: string;
    surface: string;
    ink: string;
    accent: string;
    muted: string;
    line: string;
  };
  fontFamily: string;
  templateVersion: string;
}

const BASE_VERSION = 1;

export const CARD_THEMES: Record<string, CardTheme> = {
  /** 暗房工作室（默认）：近黑底 + 琥珀 */
  darkroom: {
    name: "darkroom-knowledge",
    version: BASE_VERSION,
    colors: {
      background: "#0e0e10",
      surface: "#17171b",
      ink: "#f4f1ea",
      accent: "#f5a524",
      muted: "#9b97a0",
      line: "#2c2c33",
    },
    fontFamily: "Noto Sans SC",
    templateVersion: "darkroom-knowledge@1",
  },
  /** 纸感极简：米白纸底 + 墨黑 + 印章红 */
  paper_minimal: {
    name: "paper-minimal",
    version: BASE_VERSION,
    colors: {
      background: "#faf7f2",
      surface: "#fffdf9",
      ink: "#1c1814",
      accent: "#b5382d",
      muted: "#8a8172",
      line: "#e3dccb",
    },
    fontFamily: "Noto Sans SC",
    templateVersion: "paper-minimal@1",
  },
  /** 高对比营销：纯黑底 + 亮黄 */
  high_contrast: {
    name: "high-contrast",
    version: BASE_VERSION,
    colors: {
      background: "#111111",
      surface: "#1a1a1a",
      ink: "#ffffff",
      accent: "#ffd400",
      muted: "#9e9e9e",
      line: "#333333",
    },
    fontFamily: "Noto Sans SC",
    templateVersion: "high-contrast@1",
  },
  /** 莫兰迪生活：灰调暖底 */
  morandi: {
    name: "morandi-life",
    version: BASE_VERSION,
    colors: {
      background: "#e8e2d9",
      surface: "#f0ebe2",
      ink: "#5b554a",
      accent: "#a1876f",
      muted: "#8f887c",
      line: "#d4ccbd",
    },
    fontFamily: "Noto Sans SC",
    templateVersion: "morandi-life@1",
  },
  /** 科技深色：深蓝底 + 天青 */
  tech_dark: {
    name: "tech-dark",
    version: BASE_VERSION,
    colors: {
      background: "#0e1420",
      surface: "#16202f",
      ink: "#e6edf5",
      accent: "#38bdf8",
      muted: "#7d8ca3",
      line: "#243449",
    },
    fontFamily: "Noto Sans SC",
    templateVersion: "tech-dark@1",
  },
  /** 图书纸张：暖纸 + 棕墨 */
  book_paper: {
    name: "book-paper",
    version: BASE_VERSION,
    colors: {
      background: "#f7f1e3",
      surface: "#fdf9ef",
      ink: "#3d3428",
      accent: "#8b5e34",
      muted: "#948a76",
      line: "#e2d7c0",
    },
    fontFamily: "Noto Sans SC",
    templateVersion: "book-paper@1",
  },
};

/** 旧导出保留：默认主题（darkroom） */
export const knowledgeCardTheme: CardTheme = CARD_THEMES.darkroom!;

/** 按 Brand Kit themeId 取主题；未知 ID 回退默认 */
export function themeById(themeId: string | undefined): CardTheme {
  if (themeId && CARD_THEMES[themeId]) return CARD_THEMES[themeId]!;
  return CARD_THEMES.darkroom!;
}

/**
 * 应用 Brand Kit 色板覆盖（全部可选；未命中任何键时原样返回）。
 * 映射：primary→accent（主品牌色，用于强调），accent→muted（次要文字），background→background，ink→ink。
 * 纯函数：不修改传入主题。
 */
export function applyPaletteOverrides(
  theme: CardTheme,
  palette: PaletteOverrides | undefined,
): CardTheme {
  if (!palette) return theme;
  const colors = { ...theme.colors };
  if (palette.background) colors.background = palette.background;
  if (palette.ink) colors.ink = palette.ink;
  if (palette.primary) colors.accent = palette.primary;
  if (palette.accent) colors.muted = palette.accent;
  if (colors.background === theme.colors.background
    && colors.ink === theme.colors.ink
    && colors.accent === theme.colors.accent
    && colors.muted === theme.colors.muted) {
    return theme;
  }
  return { ...theme, colors };
}
