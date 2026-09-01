import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  try {
    return NextResponse.json(await runtime.cardRepo.disableBatch(id, admin.id));
  } catch {
    return NextResponse.json({ error: "批次不存在" }, { status: 404 });
  }
}
