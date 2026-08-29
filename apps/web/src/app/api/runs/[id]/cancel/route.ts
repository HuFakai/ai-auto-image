import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = await getRuntime();
  const run = (await runtime.runRepo.list(200)).find((r) => r.id === id);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const job = (await runtime.jobRepo.list(200)).find((j) => j.runId === id);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  await runtime.runner.cancel(job.id);
  await runtime.runRepo.updateStatus(id, "cancelled");
  return NextResponse.json({ ok: true, runId: id, jobStatus: "cancelled" });
}
