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
  primary: z.string().max(32).nullable().optional(),
  accent: z.string().max(32).nullable().optional(),
  background: z.string().max(32).nullable().optional(),
  ink: z.string().max(32).nullable().optional(),
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

/**
 * 可选文本字段：输入层接受显式 null（清除语义，与 UI/API 的 null 透传对齐），
 * 归一化为 undefined 输出，保持类型不含 null（下游 BrandOverlayConfig 等消费方无需感知）。
 */
const nullableOptional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional());

/** Brand Kit 配置快照（存入 run input，冻结） */
export const BrandKitConfigSchema = z.object({
  themeId: ThemeIdSchema.default("darkroom"),
  /** 画面风格关键词（注入图片 Prompt） */
  styleKeywords: z.array(z.string()).default([]),
  /** 禁止出现的元素/表达 */
  negativeKeywords: z.array(z.string()).default([]),
  /** Logo 资产 ID（确定性渲染页脚使用）；显式 null 表示清除 */
  logoAssetId: nullableOptional(z.string()),
  /** 品牌名（页脚/水印候选文案）；显式 null 表示清除 */
  brandName: nullableOptional(z.string().max(60)),
  /** 品牌 Slogan；显式 null 表示清除 */
  slogan: nullableOptional(z.string().max(120)),
  /** 页脚签名，如 @账号名；显式 null 表示清除 */
  footerSignature: nullableOptional(z.string().max(80)),
  /** 水印文字；显式 null 表示清除 */
  watermarkText: nullableOptional(z.string().max(40)),
  watermarkPosition: WatermarkPositionSchema.default("corner"),
  watermarkOpacity: z.number().min(0).max(1).default(0.18),
  titleFont: TitleFontSchema.default("default"),
  /** 色板覆盖（可选键全部省略或为 null 时与默认主题一致）；显式 null 表示整块清除 */
  paletteJson: nullableOptional(PaletteOverridesSchema),
  coverLayout: CoverLayoutSchema.default("default"),
});
export type BrandKitConfig = z.infer<typeof BrandKitConfigSchema>;
