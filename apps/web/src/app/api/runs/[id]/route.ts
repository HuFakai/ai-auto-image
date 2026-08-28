import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { nodeRuns, workflowRuns } from "@/server/db/schema";
import { getJobStatus } from "@/server/runner";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();
  const run = db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get();
  if (!run) return NextResponse.json({ error: "Run 不存在" }, { status: 404 });
  const nodes = db.select().from(nodeRuns).where(eq(nodeRuns.runId, id)).all();
  return NextResponse.json({ run, nodes });
}

export async function DELETE(_req: Request, { params }: Params) {
  // cancel endpoint lives at /cancel; DELETE marks run cancelled in DB
  const { id } = await params;
  const db = getDb();
  db.update(workflowRuns).set({ status: "CANCELLED", finishedAt: new Date().toISOString() }).where(eq(workflowRuns.id, id)).run();
  return NextResponse.json({ ok: true });
}
