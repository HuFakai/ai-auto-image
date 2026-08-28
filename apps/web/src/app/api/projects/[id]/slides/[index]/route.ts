import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { newId } from "@aai/ai-core";
import type { Storyboard } from "@aai/shared-schemas";
import { z } from "zod";
import { getDb } from "@/server/db";
import { projects, revisions } from "@/server/db/schema";
import { regenerateSlideAsset, rerenderSlide } from "@/server/pipeline";

type Params = { params: Promise<{ id: string; index: string }> };

const PatchSchema = z.object({
  headline: z.string().max(60).optional(),
  body: z.array(z.string().max(120)).optional(),
  visualIntent: z.string().max(500).optional(),
});

/**
 * PATCH — copy/layout edit. In deterministic mode this re-renders without AI;
 * in native mode editing copy invalidates the page image (AI call on next
 * regenerate). A Revision row records which operations cost money.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { id, index } = await params;
  const slideIndex = parseInt(index, 10);
  const body = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project?.storyboard) return NextResponse.json({ error: "项目尚未生成 Storyboard" }, { status: 400 });
  const storyboard = JSON.parse(project.storyboard) as Storyboard;
  const slide = storyboard.slides[slideIndex];
  if (!slide) return NextResponse.json({ error: "页码不存在" }, { status: 404 });

  const isNative = project.textRenderingMode === "native";
  const copyChanged =
    (body.data.headline !== undefined && body.data.headline !== slide.headline) ||
    (body.data.body !== undefined && JSON.stringify(body.data.body) !== JSON.stringify(slide.body));

  db.insert(revisions)
    .values({
      id: newId("rev"),
      projectId: id,
      slideIndex,
      kind: "copy",
      patch: JSON.stringify(body.data),
      requiresAiCall: isNative && copyChanged ? 1 : 0,
      previousStoryboard: JSON.stringify(storyboard),
    })
    .run();

  if (body.data.headline !== undefined) slide.headline = body.data.headline;
  if (body.data.body !== undefined) slide.body = body.data.body;
  if (body.data.visualIntent !== undefined) slide.visualIntent = body.data.visualIntent;
  if (copyChanged) slide.revision += 1;

  db.update(projects)
    .set({ storyboard: JSON.stringify(storyboard), updatedAt: new Date().toISOString() })
    .where(eq(projects.id, id))
    .run();

  let requiresRegeneration = false;
  if (!copyChanged || !isNative) {
    // deterministic mode: re-render locally, no AI cost
    await rerenderSlide(id, slideIndex);
  } else {
    requiresRegeneration = true;
  }

  return NextResponse.json({ ok: true, requiresRegeneration, aiCallRequired: requiresRegeneration });
}

/** POST — regenerate this slide's image (bills one image call). */
export async function POST(_req: Request, { params }: Params) {
  const { id, index } = await params;
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project?.storyboard) return NextResponse.json({ error: "项目尚未生成 Storyboard" }, { status: 400 });
  try {
    await regenerateSlideAsset(id, parseInt(index, 10), `regen_${Date.now()}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "重新生成失败" }, { status: 502 });
  }
}
