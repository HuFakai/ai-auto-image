import { z } from "zod";

/** 内置主题 ID（主题预设定义在 render-engine） */
export const THEME_IDS = [
  "darkroom",
  "paper_minimal",
  "high_contrast",
  "morandi",
  "tech_dark",
  "book_paper",
] as const;
export const ThemeIdSchema = z.enum(THEME_IDS);
export type ThemeId = (typeof THEME_IDS)[number];

/** Brand Kit 配置快照（存入 run input，冻结） */
export const BrandKitConfigSchema = z.object({
  themeId: ThemeIdSchema.default("darkroom"),
  /** 画面风格关键词（注入图片 Prompt） */
  styleKeywords: z.array(z.string()).default([]),
  /** 禁止出现的元素/表达 */
  negativeKeywords: z.array(z.string()).default([]),
  /** Logo 资产 ID（确定性渲染页脚使用） */
  logoAssetId: z.string().optional(),
});
export type BrandKitConfig = z.infer<typeof BrandKitConfigSchema>;
