import type { BrandKit } from "@aai/storage";
import type { BrandKitConfig } from "@aai/shared-schemas";
import { THEME_IDS } from "@aai/shared-schemas";
import type { BrandKitView } from "@/lib/types";

/** BrandKit 行 → 客户端安全视图（设置页 / 创作页 / API 共用） */
export function toBrandKitView(row: BrandKit): BrandKitView {
  return {
    id: row.id,
    name: row.name,
    themeId: THEME_IDS.includes(row.themeId as never) ? row.themeId : "darkroom",
    styleKeywords: JSON.parse(row.styleKeywordsJson) as string[],
    negativeKeywords: JSON.parse(row.negativeKeywordsJson) as string[],
    logoAssetId: row.logoAssetId,
    builtIn: row.builtIn === 1,
    brandName: row.brandName,
    slogan: row.slogan,
    footerSignature: row.footerSignature,
    watermarkText: row.watermarkText,
    watermarkPosition: row.watermarkPosition,
    watermarkOpacity: row.watermarkOpacity,
    titleFont: row.titleFont,
    paletteJson: row.paletteJson ? (JSON.parse(row.paletteJson) as BrandKitView["paletteJson"]) : undefined,
    coverLayout: row.coverLayout,
  };
}

/** BrandKit 行 → 冻结进 run input 的配置快照（创建运行解析品牌手册时使用） */
export function brandKitConfigFromRow(row: BrandKit): BrandKitConfig {
  return {
    themeId: (THEME_IDS.includes(row.themeId as never) ? row.themeId : "darkroom") as BrandKitConfig["themeId"],
    styleKeywords: JSON.parse(row.styleKeywordsJson) as string[],
    negativeKeywords: JSON.parse(row.negativeKeywordsJson) as string[],
    logoAssetId: row.logoAssetId ?? undefined,
    brandName: row.brandName ?? undefined,
    slogan: row.slogan ?? undefined,
    footerSignature: row.footerSignature ?? undefined,
    watermarkText: row.watermarkText ?? undefined,
    watermarkPosition: row.watermarkPosition === "center" ? "center" : "corner",
    watermarkOpacity: row.watermarkOpacity,
    titleFont: row.titleFont === "serif" || row.titleFont === "sans" ? row.titleFont : "default",
    paletteJson: row.paletteJson ? (JSON.parse(row.paletteJson) as BrandKitConfig["paletteJson"]) : undefined,
    coverLayout: row.coverLayout === "big-center" || row.coverLayout === "split" ? row.coverLayout : "default",
  };
}
