import { NextResponse } from "next/server";
import { z } from "zod";
import { PAGE_REGEN_KIND } from "@aai/workflow-engine";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

const RegenSchema = z.object({
  headline: z.string().max(200).optional(),
  body: z.array(z.string().max(500)).max(6).optional(),
  imagePromptOverride: z.string().max(4000).optional(),
});

/** 单页返修：重新生成目标页（native 重出整图；deterministic 重出视觉层并重新排版） */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await ctx.params;
  const pageIndex = Number.parseInt(index, 10);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 20) {
    return NextResponse.json({ error: "invalid page index" }, { status: 400 });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    /* 允许空 body：原样重生成 */
  }
  const parsed = RegenSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input", issues: parsed.error.issues.slice(0, 4) }, { status: 400 });
  }

  const runtime = getRuntime();
  try {
    runtime.runRepo.require(id);
  } catch {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  const run = runtime.runRepo.require(id);
  if (run.status !== "succeeded") {
    return NextResponse.json({ error: "run not finished" }, { status: 409 });
  }

  const revisionCount = runtime.assetRepo.pageVersionCount(id, pageIndex);
  const { job } = runtime.jobRepo.createOrReuse({
    kind: PAGE_REGEN_KIND,
    runId: id,
    idempotencyKey: `page_regen:${id}:${pageIndex}:v${revisionCount + 1}`,
    payloadJson: JSON.stringify({ pageIndex, ...parsed.data }),
    maxAttempts: 3,
  });
  runtime.jobRepo.appendEvent(job.id, "created", `page=${pageIndex}`);

  return NextResponse.json(
    { jobId: job.id, runId: id, pageIndex, revision: revisionCount + 1 },
    { status: 202 },
  );
}
