import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { CreateRunInputSchema, type CreateRunInput } from "@aai/shared-schemas";
import { getRuntime } from "@/server/runtime";
import { requireApiUser, userActionLimit } from "@/server/auth";
import { MIN_CREATION_CREDITS, requireCredits } from "@/server/billing";
import { estimateCheckpointCredits } from "@/server/model-pricing";

export const dynamic = "force-dynamic";

const RetrySchema = z.object({
  mode: z.enum(["checkpoint", "restart"]).default("checkpoint"),
});

const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "retry_waiting"]);

function jobKindForInput(input: CreateRunInput): "comic_story_run" | "knowledge_card_run" {
  return input.recipe === "comic_story" || input.recipe === "strip_comic"
    ? "comic_story_run"
    : "knowledge_card_run";
}

/**
 * 失败作品恢复：checkpoint 复用同一 Run 中已成功的节点/图片，restart 创建一条全新的 Run。
 * 两种模式都使用原生图片生成管线，并保留旧失败作品作为排障记录。
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userActionLimit(`retry-run:${user.id}`, 10, 60_000)) {
    return NextResponse.json(
      { error: "操作过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    /* 空 body 使用默认的 checkpoint 模式 */
  }
  const parsed = RetrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid retry mode" }, { status: 400 });
  }

  const runtime = await getRuntime();
  const run = await runtime.runRepo.require(id).catch(() => null);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  if (run.userId && run.userId !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (run.status !== "failed") {
    return NextResponse.json(
      { error: "只有生成失败的作品可以重试", runStatus: run.status },
      { status: 409 },
    );
  }

  const latestJob = await runtime.jobRepo.findByRunId(id);
  if (latestJob && ACTIVE_JOB_STATUSES.has(latestJob.status)) {
    return NextResponse.json({ error: "作品仍在生成或等待重试，请稍候" }, { status: 409 });
  }

  let input: CreateRunInput;
  try {
    // 通过当前 schema 重新校验，兼容旧作品中已删除的渲染字段并避免把非法数据带入新任务。
    input = CreateRunInputSchema.parse(JSON.parse(run.inputJson));
  } catch {
    return NextResponse.json({ error: "作品输入已损坏，无法重试" }, { status: 409 });
  }

  // checkpoint 通常只补失败节点，按当前冻结候选价格做保守预检；restart 至少要求创作准入额度。
  let neededCredits = MIN_CREATION_CREDITS;
  if (parsed.data.mode === "checkpoint") {
    try {
      neededCredits = await estimateCheckpointCredits(runtime, input);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "模型渠道当前不可用" },
        { status: 409 },
      );
    }
  }
  const billingGuard = await requireCredits(
    user.id,
    neededCredits,
  );
  if (billingGuard) return billingGuard;

  const kind = jobKindForInput(input);
  if (parsed.data.mode === "checkpoint") {
    await runtime.runRepo.updateStatus(id, "queued", { errorSummary: null });
    const { job } = await runtime.jobRepo.createOrReuse({
      kind,
      runId: id,
      idempotencyKey: `${kind}:${id}:checkpoint:${randomUUID()}`,
      payloadJson: JSON.stringify({ mode: "checkpoint", sourceRunId: id }),
      maxAttempts: 3,
    });
    await runtime.jobRepo.appendEvent(job.id, "created", `retry=checkpoint;sourceRun=${id}`);
    return NextResponse.json(
      { runId: id, jobId: job.id, mode: parsed.data.mode, reused: false },
      { status: 202 },
    );
  }

  const project = await runtime.projectRepo.require(run.projectId).catch(() => null);
  if (!project) return NextResponse.json({ error: "作品项目不存在，无法重试" }, { status: 409 });
  const title = `${project.title.slice(0, 54)} · 重试`;
  const newProject = await runtime.projectRepo.create({ title, userId: user.id });
  const newRun = await runtime.runRepo.create({
    projectId: newProject.id,
    inputJson: JSON.stringify(input),
    userId: user.id,
  });
  const { job } = await runtime.jobRepo.createOrReuse({
    kind,
    runId: newRun.id,
    idempotencyKey: `${kind}:${newRun.id}`,
    payloadJson: JSON.stringify({ mode: "restart", sourceRunId: id }),
    maxAttempts: 3,
  });
  await runtime.jobRepo.appendEvent(job.id, "created", `retry=restart;sourceRun=${id}`);

  return NextResponse.json(
    { runId: newRun.id, jobId: job.id, mode: parsed.data.mode, sourceRunId: id, reused: false },
    { status: 202 },
  );
}
