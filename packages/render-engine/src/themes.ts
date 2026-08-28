import type { AspectRatio, BrandKit } from "@aai/shared-schemas";

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "3:4": { width: 1242, height: 1656 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
};

export type ThemeId =
  | "minimal-knowledge"
  | "magazine"
  | "high-contrast"
  | "morandi"
  | "tech-dark"
  | "book-paper";

export interface ThemeConfig {
  id: ThemeId;
  name: string;
  background: string;
  /** Optional decorative gradient stops. */
  gradient?: [string, string];
  headingColor: string;
  bodyColor: string;
  accentColor: string;
  mutedColor: string;
  cardBackground: string;
  headingWeight: "bold" | "normal";
  letterSpacing?: string;
  padding: number;
  badgeBackground?: string;
  badgeColor?: string;
}

export const BUILTIN_THEMES: Record<ThemeId, ThemeConfig> = {
  "minimal-knowledge": {
    id: "minimal-knowledge",
    name: "极简知识",
    background: "#fafaf9",
    headingColor: "#1c1917",
    bodyColor: "#44403c",
    accentColor: "#0f766e",
    mutedColor: "#a8a29e",
    cardBackground: "#ffffff",
    headingWeight: "bold",
    padding: 88,
  },
  magazine: {
    id: "magazine",
    name: "杂志编辑",
    background: "#f7f3ec",
    headingColor: "#1f1b16",
    bodyColor: "#4a4238",
    accentColor: "#b45309",
    mutedColor: "#a8998a",
    cardBackground: "#fffdf8",
    headingWeight: "bold",
    letterSpacing: "0.02em",
    padding: 80,
  },
  "high-contrast": {
    id: "high-contrast",
    name: "高对比营销",
    background: "#111827",
    headingColor: "#ffffff",
    bodyColor: "#e5e7eb",
    accentColor: "#f59e0b",
    mutedColor: "#9ca3af",
    cardBackground: "#1f2937",
    headingWeight: "bold",
    padding: 84,
    badgeBackground: "#f59e0b",
    badgeColor: "#111827",
  },
  morandi: {
    id: "morandi",
    name: "莫兰迪生活",
    background: "#e8e2da",
    gradient: ["#e8e2da", "#d8cfc4"],
    headingColor: "#4a423c",
    bodyColor: "#6b5f55",
    accentColor: "#9a8178",
    mutedColor: "#a99e93",
    cardBackground: "#f3efe9",
    headingWeight: "bold",
    padding: 88,
  },
  "tech-dark": {
    id: "tech-dark",
    name: "科技深色",
    background: "#0b1220",
    gradient: ["#0b1220", "#111c33"],
    headingColor: "#f1f5f9",
    bodyColor: "#cbd5e1",
    accentColor: "#38bdf8",
    mutedColor: "#64748b",
    cardBackground: "#16223a",
    headingWeight: "bold",
    padding: 84,
  },
  "book-paper": {
    id: "book-paper",
    name: "图书纸张",
    background: "#f5efe0",
    headingColor: "#3f3222",
    bodyColor: "#5c4d38",
    accentColor: "#8c6d3f",
    mutedColor: "#b3a488",
    cardBackground: "#fdfaf2",
    headingWeight: "bold",
    padding: 90,
  },
};

/** Merge a brand kit onto a base theme. */
export function resolveTheme(themeId: ThemeId, brand?: Pick<BrandKit, "primaryColor" | "secondaryColor" | "backgroundColor"> | null): ThemeConfig {
  const base = BUILTIN_THEMES[themeId];
  if (!brand) return base;
  return {
    ...base,
    headingColor: brand.primaryColor || base.headingColor,
    bodyColor: brand.secondaryColor || base.bodyColor,
    background: brand.backgroundColor || base.background,
  };
}
