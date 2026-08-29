import { NextResponse } from "next/server";
import { z } from "zod";
import { ThemeIdSchema } from "@aai/shared-schemas";
import { toBrandKitView } from "@/server/brand-kit-views";
import { getRuntime } from "@/server/runtime";
import { requireAdmin, requireApiUser } from "@/server/auth";

export const dynamic = "force-dynamic";

const KitSchema = z.object({
  name: z.string().min(1).max(40),
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

export async function GET() {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runtime = await getRuntime();
  return NextResponse.json({ kits: (await runtime.brandKitRepo.list()).map(toBrandKitView) });
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
  const parsed = KitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues.slice(0, 4) }, { status: 400 });
  }
  const runtime = await getRuntime();
  const kit = await runtime.brandKitRepo.create({
    name: parsed.data.name,
    themeId: parsed.data.themeId,
    styleKeywords: parsed.data.styleKeywords,
    negativeKeywords: parsed.data.negativeKeywords,
    logoAssetId: parsed.data.logoAssetId ?? null,
    brandName: parsed.data.brandName ?? null,
    slogan: parsed.data.slogan ?? null,
    footerSignature: parsed.data.footerSignature ?? null,
    watermarkText: parsed.data.watermarkText ?? null,
    watermarkPosition: parsed.data.watermarkPosition,
    watermarkOpacity: parsed.data.watermarkOpacity,
    titleFont: parsed.data.titleFont,
    paletteJson: parsed.data.paletteJson,
    coverLayout: parsed.data.coverLayout,
  });
  return NextResponse.json({ kit: toBrandKitView(kit) }, { status: 201 });
}
