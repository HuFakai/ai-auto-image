import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = getRuntime();
  const run = runtime.runRepo.list(200).find((r) => r.id === id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const job = runtime.jobRepo.list(200).find((j) => j.runId === id);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  runtime.runner.cancel(job.id);
  runtime.runRepo.updateStatus(id, "cancelled");
  return NextResponse.json({ ok: true, runId: id, jobStatus: "cancelled" });
}
