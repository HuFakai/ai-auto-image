import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { buildRunDetail } from "@/server/run-views";
import { requireApiUser } from "@/server/auth";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runtime = await getRuntime();
  let run;
  try {
    run = await runtime.runRepo.require(id);
  } catch {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  if (run.userId && run.userId !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const detail = await buildRunDetail(runtime, id);
  if (!detail) return NextResponse.json({ error: "run not found" }, { status: 404 });
  return NextResponse.json(detail);
}
