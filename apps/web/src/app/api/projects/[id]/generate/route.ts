import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { projects, workflowRuns } from "@/server/db/schema";
import { newId } from "@aai/ai-core";
import { enqueueGeneration, ensureJobRunner } from "@/server/runner";
import { resolveEffectiveConcurrency, concurrencyConfig } from "@/server/config";
import { stateFromProject, estimateRunCostCents } from "@/server/pipeline";
import { budgetExceededCents, dispatchWebhook } from "@/server/openplatform";
import type { TextRenderingMode } from "@aai/shared-schemas";
import { z } from "zod";

type Params = { params: Promise<{ id: string }> };

const BodySchema = z.object({
  textRenderingMode: z.enum(["native", "deterministic", "auto_fallback"]).optional(),
  imageConcurrency: z.number().int().min(1).max(16).optional(),
});

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const body = BodySchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!body.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });

  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  // budget gate — block before spend (phase 4)
  const exceeded = budgetExceededCents();
  if (exceeded !== null) {
    return NextResponse.json(
      { error: `本月预算已用完（已使用 ${exceeded} 分），任务未启动`, code: "BUDGET_EXCEEDED" },
      { status: 402 }
    );
  }

  const mode = (body.data.textRenderingMode ?? project.textRenderingMode) as TextRenderingMode;
  const requested = body.data.imageConcurrency ?? project.imageConcurrency;
  const conc = resolveEffectiveConcurrency(requested);
  const state = stateFromProject(id);
  const slideEstimate = state.storyboard?.slides.length ?? 8;
  const estimate = estimateRunCostCents(slideEstimate, mode);

  const runId = newId("run");
  db.insert(workflowRuns)
    .values({
      id: runId,
      projectId: id,
      status: "PLANNING",
      concurrencyRequested: conc.requested,
      concurrencyEffective: conc.effective,
      textRenderingMode: mode,
      estimatedCostCny: estimate,
    })
    .run();
  db.update(projects)
    .set({
      status: "GENERATING",
      textRenderingMode: mode,
      imageConcurrency: conc.requested,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projects.id, id))
    .run();

  await ensureJobRunner();
  await enqueueGeneration(id, runId);
  void dispatchWebhook("run.completed", { runId, projectId: id }).catch(() => {});

  return NextResponse.json({ runId, concurrency: conc, estimatedCostCents: estimate }, { status: 202 });
}
