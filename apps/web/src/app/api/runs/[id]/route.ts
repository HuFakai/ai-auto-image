import fs from "node:fs";
import path from "node:path";
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

/** 删除作品:数据库级联(project→runs→节点/资产/作业记录)+ 媒体文件与导出目录 */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
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
  if (run.status === "running" || run.status === "queued") {
    return NextResponse.json({ error: "作品生成中,请先取消再删除" }, { status: 409 });
  }

  // 1) 数据库级联:project → workflow_runs → node_runs/assets/revisions/jobs/job_events
  await runtime.projectRepo.delete(run.projectId);

  // 2) 媒体文件:资产目录 runs/<runId> + 导出目录 exports/<runId>;失败不阻塞,记日志
  try {
    runtime.assetStore.deleteRunAssets(id);
  } catch (error) {
    console.error(
      JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "delete run assets failed", runId: id, error: String(error) }),
    );
  }
  try {
    fs.rmSync(path.join(runtime.config.exportsDir, id), { recursive: true, force: true });
  } catch (error) {
    console.error(
      JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "delete run exports failed", runId: id, error: String(error) }),
    );
  }

  return NextResponse.json({ ok: true });
}
