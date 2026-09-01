import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  const changed = await runtime.cardRepo.revokeApiKey(id, admin.id);
  return changed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "API Key 不存在或已吊销" }, { status: 409 });
}
