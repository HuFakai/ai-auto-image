import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { approvals, projects, workflowRuns } from "@/server/db/schema";
import { newId } from "@aai/ai-core";
import { dispatchWebhook } from "@/server/openplatform";

export async function GET() {
  const db = getDb();
  const rows = db.select().from(approvals).orderBy(desc(approvals.createdAt)).limit(100).all();
  return NextResponse.json({ approvals: rows });
}

const PostSchema = z.object({
  projectId: z.string(),
  runId: z.string().optional(),
  kind: z.enum(["direction", "title", "final", "publish"]),
});

export async function POST(req: Request) {
  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  const db = getDb();
  const id = newId("apr");
  db.insert(approvals)
    .values({
      id,
      projectId: parsed.data.projectId,
      runId: parsed.data.runId ?? null,
      kind: parsed.data.kind,
    })
    .run();
  await dispatchWebhook("approval.required", { approvalId: id, projectId: parsed.data.projectId, kind: parsed.data.kind });
  return NextResponse.json({ id }, { status: 201 });
}

const DecideSchema = z.object({
  id: z.string(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().optional(),
  decidedBy: z.string().default("user_default"),
});

export async function PUT(req: Request) {
  const parsed = DecideSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  const db = getDb();
  const row = db.select().from(approvals).where(eq(approvals.id, parsed.data.id)).get();
  if (!row) return NextResponse.json({ error: "审批不存在" }, { status: 404 });
  db.update(approvals)
    .set({
      status: parsed.data.decision,
      note: parsed.data.note ?? null,
      decidedBy: parsed.data.decidedBy,
      decidedAt: new Date().toISOString(),
    })
    .where(eq(approvals.id, parsed.data.id))
    .run();
  if (row.kind === "final" && parsed.data.decision === "approved") {
    db.update(projects).set({ status: "READY_TO_EXPORT", updatedAt: new Date().toISOString() }).where(eq(projects.id, row.projectId)).run();
  }
  return NextResponse.json({ ok: true });
}
