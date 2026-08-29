import { NextResponse } from "next/server";
import { z } from "zod";
import { renderSlideDeterministic, themeById } from "@aai/render-engine";
import { ThemeIdSchema, type BrandKitConfig, type StoryboardSlide } from "@aai/shared-schemas";
import { getRuntime } from "@/server/runtime";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

/** 预览入参：一份 Brand Kit 配置（不必已保存；服务端只读，不落库） */
const PreviewSchema = z.object({
  name: z.string().max(40).optional(),
  themeId: ThemeIdSchema.default("darkroom"),
  styleKeywords: z.array(z.string().max(40)).max(10).default([]),
  negativeKeywords: z.array(z.string().max(40)).max(10).default([]),
  logoAssetId: z.string().optional(),
  brandName: z.string().max(60).optional(),
  slogan: z.string().max(120).optional(),
  footerSignature: z.string().max(80).optional(),
  watermarkText: z.string().max(40).optional(),
  watermarkPosition: z.enum(["corner", "center"]).default("corner"),
  watermarkOpacity: z.number().min(0).max(1).default(0.18),
  titleFont: z.enum(["default", "serif", "sans"]).default("default"),
  paletteJson: z
    .object({
      primary: z.string().optional(),
      accent: z.string().optional(),
      background: z.string().optional(),
      ink: z.string().optional(),
    })
    .optional(),
  coverLayout: z.enum(["default", "big-center", "split"]).default("default"),
});

/** 固定样张：3:4 封面页，零模型费用 */
function sampleSlide(): StoryboardSlide {
  return {
    index: 0,
    role: "cover",
    headline: "品牌手册样张",
    body: ["这里是示例正文", "用于预览色板、字体与页脚签名", "水印会叠加在成品图上"],
    visualIntent: "示例",
    layoutHint: "cover",
  };
}

function toBrandConfig(data: z.infer<typeof PreviewSchema>): BrandKitConfig {
  return {
    themeId: data.themeId,
    styleKeywords: data.styleKeywords,
    negativeKeywords: data.negativeKeywords,
    logoAssetId: data.logoAssetId,
    brandName: data.brandName,
    slogan: data.slogan,
    footerSignature: data.footerSignature,
    watermarkText: data.watermarkText,
    watermarkPosition: data.watermarkPosition,
    watermarkOpacity: data.watermarkOpacity,
    titleFont: data.titleFont,
    paletteJson: data.paletteJson,
    coverLayout: data.coverLayout,
  };
}

export async function POST(request: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = PreviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues.slice(0, 4) },
      { status: 400 },
    );
  }
  try {
    // 确保运行时就绪（含字体校验）；渲染本身不调用任何模型
    await getRuntime();
    const buffer = await renderSlideDeterministic({
      theme: themeById(parsed.data.themeId),
      aspectRatio: "3:4",
      slide: sampleSlide(),
      pageCount: 1,
      brand: toBrandConfig(parsed.data),
    });
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "content-type": "image/png",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error).slice(0, 200) },
      { status: 400 },
    );
  }
}
