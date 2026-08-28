import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { projects } from "@/server/db/schema";
import { exportProject } from "@/server/exporter";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  try {
    const result = await exportProject(id);
    db.update(projects)
      .set({ status: "READY_TO_EXPORT", updatedAt: new Date().toISOString() })
      .where(eq(projects.id, id))
      .run();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "导出失败" }, { status: 400 });
  }
}
