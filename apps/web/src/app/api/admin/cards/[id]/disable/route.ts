import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  const changed = await runtime.cardRepo.disableCard(id, admin.id);
  return changed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "卡密不存在或已不是可用状态" }, { status: 409 });
}
