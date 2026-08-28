import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { jobs, projects, workflowRuns } from "@/server/db/schema";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();
  const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get();
  if (!run) return NextResponse.json({ error: "Run 不存在" }, { status: 404 });
  // cancel queued job if not started; running jobs observe next poll
  db.update(jobs).set({ status: "cancelled", updatedAt: new Date().toISOString() }).where(eq(jobs.runId, id)).run();
  db.update(workflowRuns).set({ status: "CANCELLED", finishedAt: new Date().toISOString() }).where(eq(workflowRuns.id, id)).run();
  db.update(projects).set({ status: "PAUSED", updatedAt: new Date().toISOString() }).where(eq(projects.id, run.projectId)).run();
  return NextResponse.json({ ok: true });
}
