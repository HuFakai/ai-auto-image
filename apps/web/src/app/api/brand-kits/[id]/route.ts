import { NextResponse } from "next/server";
import { z } from "zod";
import { ThemeIdSchema } from "@aai/shared-schemas";
import { getRuntime } from "@/server/runtime";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  themeId: ThemeIdSchema.optional(),
  styleKeywords: z.array(z.string().max(40)).max(10).optional(),
  negativeKeywords: z.array(z.string().max(40)).max(10).optional(),
  logoAssetId: z.string().nullable().optional(),
  brandName: z.string().max(60).nullable().optional(),
  slogan: z.string().max(120).nullable().optional(),
  footerSignature: z.string().max(80).nullable().optional(),
  watermarkText: z.string().max(40).nullable().optional(),
  watermarkPosition: z.enum(["corner", "center"]).optional(),
  watermarkOpacity: z.number().min(0).max(1).optional(),
  titleFont: z.enum(["default", "serif", "sans"]).optional(),
  paletteJson: z
    .object({
      primary: z.string().max(32).nullable().optional(),
      accent: z.string().max(32).nullable().optional(),
      background: z.string().max(32).nullable().optional(),
      ink: z.string().max(32).nullable().optional(),
    })
    .nullable()
    .optional(),
  coverLayout: z.enum(["default", "big-center", "split"]).optional(),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }
  const runtime = await getRuntime();
  try {
    const kit = await runtime.brandKitRepo.update(id, parsed.data);
    return NextResponse.json({ kit: { id: kit.id, name: kit.name } });
  } catch {
    return NextResponse.json({ error: "brand kit not found" }, { status: 404 });
  }
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  const kit = await runtime.brandKitRepo.require(id);
  if (kit.builtIn === 1) {
    return NextResponse.json({ error: "内置主题不可删除，可编辑改名" }, { status: 409 });
  }
  await runtime.brandKitRepo.delete(id);
  return NextResponse.json({ ok: true });
}
