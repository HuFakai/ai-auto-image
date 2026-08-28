import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import z from "zod";
import { getDb, assetRoot } from "@/server/db";
import { assets, projects, revisions, workflowRuns, qualityReports } from "@/server/db/schema";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const runs = db.select().from(workflowRuns).where(eq(workflowRuns.projectId, id)).orderBy(desc(workflowRuns.createdAt)).all();
  const latestRun = runs[0] ?? null;
  // all non-deleted project assets regardless of which run produced them
  // (re-renders happen outside the original run)
  const pageAssets = db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, id), eq(assets.deleted, 0)))
    .all();
  const latestQuality = db
    .select()
    .from(qualityReports)
    .where(eq(qualityReports.projectId, id))
    .orderBy(desc(qualityReports.createdAt))
    .get();
  const revs = db.select().from(revisions).where(eq(revisions.projectId, id)).orderBy(desc(revisions.createdAt)).limit(50).all();

  return NextResponse.json({
    project,
    latestRun,
    runs: runs.slice(0, 10),
    assets: pageAssets,
    qualityReport: latestQuality ? JSON.parse(latestQuality.report) : null,
    revisions: revs,
  });
}

const PatchSchema = z.object({
  title: z.string().max(100).optional(),
  storyboard: z.unknown().optional(),
  status: z.string().optional(),
  archived: z.boolean().optional(),
  textRenderingMode: z.string().optional(),
  themeId: z.string().optional(),
});

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const body = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  const db = getDb();
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.data.title !== undefined) patch.title = body.data.title;
  if (body.data.storyboard !== undefined) patch.storyboard = JSON.stringify(body.data.storyboard);
  if (body.data.status !== undefined) patch.status = body.data.status;
  if (body.data.archived !== undefined) patch.archived = body.data.archived ? 1 : 0;
  if (body.data.textRenderingMode !== undefined) patch.textRenderingMode = body.data.textRenderingMode;
  if (body.data.themeId !== undefined) patch.themeId = body.data.themeId;
  db.update(projects).set(patch).where(eq(projects.id, id)).run();
  return NextResponse.json({ project: db.select().from(projects).where(eq(projects.id, id)).get() });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();
  db.update(projects).set({ archived: 1, updatedAt: new Date().toISOString() }).where(eq(projects.id, id)).run();
  return NextResponse.json({ ok: true });
}
