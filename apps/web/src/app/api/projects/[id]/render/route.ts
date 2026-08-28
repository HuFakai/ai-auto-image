import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { projects } from "@/server/db/schema";
import { rerenderSlide } from "@/server/pipeline";
import type { Storyboard } from "@aai/shared-schemas";

type Params = { params: Promise<{ id: string }> };

/** Re-render all slides deterministically (theme change) — zero AI calls. */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project?.storyboard) return NextResponse.json({ error: "项目尚未生成 Storyboard" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { themeId?: string };
  if (body.themeId) {
    db.update(projects).set({ themeId: body.themeId, updatedAt: new Date().toISOString() }).where(eq(projects.id, id)).run();
  }
  const storyboard = JSON.parse(project.storyboard) as Storyboard;
  try {
    // sequential: each pass re-reads fresh state, avoiding composite races
    for (const s of storyboard.slides) {
      await rerenderSlide(id, s.index);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "渲染失败" }, { status: 500 });
  }
}
