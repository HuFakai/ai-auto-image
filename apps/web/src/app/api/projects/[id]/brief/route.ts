import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { projects } from "@/server/db/schema";
import { handleGenerateBrief, stateFromProject } from "@/server/pipeline";

type Params = { params: Promise<{ id: string }> };

/** Generate (or regenerate) only the Content Brief for preview before committing to image spend. */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const state = stateFromProject(id);
  const ctx = {
    runId: `brief_${Date.now()}`,
    projectId: id,
    nodeKey: "brief-preview",
    attempt: 1,
    outputs: new Map<string, unknown>([["state", state]]),
    inputs: new Map<string, unknown>(),
    signal: new AbortController().signal,
    log: () => {},
  };
  try {
    await handleGenerateBrief(ctx);
    return NextResponse.json({ brief: state.brief });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "生成失败" }, { status: 502 });
  }
}
