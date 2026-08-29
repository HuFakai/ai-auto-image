import { NextResponse } from "next/server";
import { z } from "zod";
import { ThemeIdSchema } from "@aai/shared-schemas";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  themeId: ThemeIdSchema.optional(),
  styleKeywords: z.array(z.string().max(40)).max(10).optional(),
  negativeKeywords: z.array(z.string().max(40)).max(10).optional(),
  logoAssetId: z.string().optional(),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
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
  const runtime = getRuntime();
  try {
    const kit = runtime.brandKitRepo.update(id, parsed.data);
    return NextResponse.json({ kit: { id: kit.id, name: kit.name } });
  } catch {
    return NextResponse.json({ error: "brand kit not found" }, { status: 404 });
  }
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = getRuntime();
  const kit = runtime.brandKitRepo.require(id);
  if (kit.builtIn === 1) {
    return NextResponse.json({ error: "内置主题不可删除，可编辑改名" }, { status: 409 });
  }
  runtime.brandKitRepo.delete(id);
  return NextResponse.json({ ok: true });
}
