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

/** 色板覆盖：全可选，命中后覆盖主题对应颜色（primary→accent，accent→muted，background→background，ink→ink） */
export const PaletteOverridesSchema = z.object({
  primary: z.string().optional(),
  accent: z.string().optional(),
  background: z.string().optional(),
  ink: z.string().optional(),
});
export type PaletteOverrides = z.infer<typeof PaletteOverridesSchema>;

/** 水印位置：corner（右下角斜置小字）| center（居中大字平铺一次） */
export const WatermarkPositionSchema = z.enum(["corner", "center"]);
export type WatermarkPosition = z.infer<typeof WatermarkPositionSchema>;

/** 标题字体：default（跟随主题）| serif（衬线）| sans（无衬线） */
export const TitleFontSchema = z.enum(["default", "serif", "sans"]);
export type TitleFont = z.infer<typeof TitleFontSchema>;

/** 封面标题布局 */
export const CoverLayoutSchema = z.enum(["default", "big-center", "split"]);
export type CoverLayout = z.infer<typeof CoverLayoutSchema>;

/** Brand Kit 配置快照（存入 run input，冻结） */
export const BrandKitConfigSchema = z.object({
  themeId: ThemeIdSchema.default("darkroom"),
  /** 画面风格关键词（注入图片 Prompt） */
  styleKeywords: z.array(z.string()).default([]),
  /** 禁止出现的元素/表达 */
  negativeKeywords: z.array(z.string()).default([]),
  /** Logo 资产 ID（确定性渲染页脚使用） */
  logoAssetId: z.string().optional(),
  /** 品牌名（页脚/水印候选文案） */
  brandName: z.string().max(60).optional(),
  /** 品牌 Slogan */
  slogan: z.string().max(120).optional(),
  /** 页脚签名，如 @账号名 */
  footerSignature: z.string().max(80).optional(),
  /** 水印文字 */
  watermarkText: z.string().max(40).optional(),
  watermarkPosition: WatermarkPositionSchema.default("corner"),
  watermarkOpacity: z.number().min(0).max(1).default(0.18),
  titleFont: TitleFontSchema.default("default"),
  /** 色板覆盖（可选键全部省略时与默认主题一致） */
  paletteJson: PaletteOverridesSchema.optional(),
  coverLayout: CoverLayoutSchema.default("default"),
});
export type BrandKitConfig = z.infer<typeof BrandKitConfigSchema>;
