import { NextResponse } from "next/server";
import { z } from "zod";
import type { BrandKit } from "@aai/storage";
import type { BrandKitView } from "@/lib/types";
import { THEME_IDS, ThemeIdSchema } from "@aai/shared-schemas";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

const KitSchema = z.object({
  name: z.string().min(1).max(40),
  themeId: ThemeIdSchema.default("darkroom"),
  styleKeywords: z.array(z.string().max(40)).max(10).default([]),
  negativeKeywords: z.array(z.string().max(40)).max(10).default([]),
  logoAssetId: z.string().optional(),
});

function view(row: BrandKit): BrandKitView {
  return {
    id: row.id,
    name: row.name,
    themeId: THEME_IDS.includes(row.themeId as never) ? row.themeId : "darkroom",
    styleKeywords: JSON.parse(row.styleKeywordsJson) as string[],
    negativeKeywords: JSON.parse(row.negativeKeywordsJson) as string[],
    logoAssetId: row.logoAssetId,
    builtIn: row.builtIn === 1,
  };
}

export async function GET() {
  const runtime = await getRuntime();
  return NextResponse.json({ kits: (await runtime.brandKitRepo.list()).map(view) });
}

export async function POST(request: Request) {
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
  });
  return NextResponse.json({ kit: view(kit) }, { status: 201 });
}
