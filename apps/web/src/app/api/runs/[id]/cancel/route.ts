import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runtime = await getRuntime();
  // 按主键取 run（不再 list(200).find：老 run 在列表窗口外会误报 404）
  const run = await runtime.runRepo.require(id).catch(() => null);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  if (run.userId && run.userId !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // 已终态（succeeded/cancelled）：直接返回当前状态，不再写 cancelled。
  // failed 不在此列：它是页失败→Job 重试期间的瞬态，用户取消应取消重试中的 Job。
  if (run.status === "succeeded" || run.status === "cancelled") {
    return NextResponse.json({ ok: true, runId: id, runStatus: run.status });
  }
  const job = await runtime.jobRepo.findByRunId(id);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  const cancelled = await runtime.runner.cancel(job.id);
  if (!cancelled) {
    // runner.cancel 判定 job 已终态未写入；run 大概率同为终态，回读返回当前状态
    const latest = await runtime.runRepo.require(id);
    return NextResponse.json({ ok: true, runId: id, runStatus: latest.status });
  }
  await runtime.runRepo.updateStatus(id, "cancelled");
  return NextResponse.json({ ok: true, runId: id, jobStatus: "cancelled" });
}
