import { NextResponse } from "next/server";
import { z } from "zod";
import { PAGE_REGEN_KIND } from "@aai/workflow-engine";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";
import { requireCredits } from "@/server/billing";

export const dynamic = "force-dynamic";

const RegenSchema = z.object({
  headline: z.string().max(200).optional(),
  body: z.array(z.string().max(500)).max(6).optional(),
  imagePromptOverride: z.string().max(4000).optional(),
});

/** 单页返修：重新生成目标页的完整图片 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; index: string }> },
) {
  const { id, index } = await ctx.params;
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  const runtime = await getRuntime();
  let run;
  try {
    run = await runtime.runRepo.require(id);
  } catch {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  if (run.userId && run.userId !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (run.status !== "succeeded" && run.status !== "failed") {
    return NextResponse.json({ error: "作品仍在生成，请等待当前任务结束" }, { status: 409 });
  }

  const current = await runtime.assetRepo.latestForPage(id, pageIndex);
  let failedNodeName: "generate-images" | "generate-comic-pages" | null = null;
  if (run.status === "failed") {
    // 失败作品的单页按钮只允许修复确实没有当前成品的页面；已有成品请使用普通返修。
    if (current) {
      return NextResponse.json({ error: "该页面已有成品，请使用页面返修" }, { status: 409 });
    }
    const nodes = await runtime.runRepo.listNodeRuns(id);
    const failedPage = nodes.some((node) => {
      if (node.status !== "failed" || (node.nodeName !== "generate-images" && node.nodeName !== "generate-comic-pages")) {
        return false;
      }
      try {
        if ((JSON.parse(node.outputRef ?? "{}") as { pageIndex?: number }).pageIndex !== pageIndex) return false;
        failedNodeName = node.nodeName;
        return true;
      } catch {
        return false;
      }
    });
    if (!failedPage) {
      return NextResponse.json({ error: "该页面没有可恢复的失败记录" }, { status: 409 });
    }
  }

  const activeRegen = await runtime.jobRepo.findLatestByRunIdAndKind(
    id,
    failedNodeName === "generate-comic-pages" ? "comic_story_run" : PAGE_REGEN_KIND,
  );
  if (activeRegen && ["queued", "running", "retry_waiting"].includes(activeRegen.status)) {
    return NextResponse.json({ error: "该作品已有页面重试任务在处理中" }, { status: 409 });
  }

  // 单图重试只消耗 1 点；完整运行的其余图片由工作流按实际需求预留。
  const billingGuard = await requireCredits(user.id, 1);
  if (billingGuard) return billingGuard;

  if (run.status === "failed") {
    // 让详情页进入处理中状态；成功后工作流会根据所有页面是否齐全恢复为 succeeded。
    await runtime.runRepo.updateStatus(id, "queued", { errorSummary: null });
  }

  if (failedNodeName === "generate-comic-pages") {
    const { job } = await runtime.jobRepo.createOrReuse({
      kind: "comic_story_run",
      runId: id,
      idempotencyKey: `comic_story_run:${id}:page:${pageIndex}:v${await runtime.assetRepo.pageVersionCount(id, pageIndex) + 1}`,
      payloadJson: JSON.stringify({ mode: "page", targetPageIndex: pageIndex, sourceRunId: id }),
      maxAttempts: 3,
    });
    await runtime.jobRepo.appendEvent(job.id, "created", `retry=page;page=${pageIndex}`);
    return NextResponse.json(
      { jobId: job.id, runId: id, pageIndex, revision: 1, mode: "page" },
      { status: 202 },
    );
  }

  const revisionCount = await runtime.assetRepo.pageVersionCount(id, pageIndex);
  const { job } = await runtime.jobRepo.createOrReuse({
    kind: PAGE_REGEN_KIND,
    runId: id,
    idempotencyKey: `page_regen:${id}:${pageIndex}:v${revisionCount + 1}`,
    payloadJson: JSON.stringify({ pageIndex, ...parsed.data }),
    maxAttempts: 3,
  });
  await runtime.jobRepo.appendEvent(job.id, "created", `page=${pageIndex}`);

  return NextResponse.json(
    { jobId: job.id, runId: id, pageIndex, revision: revisionCount + 1 },
    { status: 202 },
  );
}
