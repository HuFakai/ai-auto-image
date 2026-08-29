import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { buildRunDetail } from "@/server/run-views";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = getRuntime();
  const detail = buildRunDetail(runtime, id);
  if (!detail) return NextResponse.json({ error: "run not found" }, { status: 404 });
  return NextResponse.json(detail);
}
