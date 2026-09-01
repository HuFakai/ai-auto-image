import { NextResponse } from "next/server";
import type { CreateRunInput } from "@aai/shared-schemas";
import { getRuntime } from "@/server/runtime";
import { requireApiUser, userActionLimit } from "@/server/auth";
import { requireCredits } from "@/server/billing";
import { estimateImageCallCredits } from "@/server/model-pricing";

export const dynamic = "force-dynamic";

/**
 * 手动补生成封面候选（POST）：为已完成的非漫画作品入队 cover_generate 作业。
 * 封面是增强能力：作业失败不影响 run 状态；已成功生成过的作品直接 409（不重复消耗图片额度）。
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 会消耗 3 次图片调用额度，限流防滥用
  if (!userActionLimit(`cover-generate:${user.id}`, 6, 60_000)) {
    return NextResponse.json(
      { error: "操作过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
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
  if (run.status !== "succeeded") {
    return NextResponse.json({ error: "run not finished" }, { status: 409 });
  }
  const input = JSON.parse(run.inputJson) as CreateRunInput;
  if (input.recipe === "comic_story" || input.recipe === "strip_comic") {
    return NextResponse.json(
      { error: "comic-unsupported", hint: "漫画以首页作为封面，暂不支持单独生成封面候选" },
      { status: 400 },
    );
  }

  // 三张封面候选按当前图片模型单次价格预检；实际生成仍逐张按成功路由结算。
  let coverCredits: number;
  try {
    coverCredits = 3 * (await estimateImageCallCredits(runtime, input));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "图片模型当前不可用" },
      { status: 409 },
    );
  }
  const billingGuard = await requireCredits(user.id, coverCredits);
  if (billingGuard) return billingGuard;

  // 已成功生成过封面：整体跳过（generate-covers 幂等），不重复消耗额度
  const nodes = await runtime.runRepo.listNodeRuns(id);
  if (nodes.some((n) => n.nodeName === "generate-covers" && n.status === "succeeded")) {
    return NextResponse.json({ error: "covers-exist", hint: "封面候选已生成" }, { status: 409 });
  }

  const baseKey = `cover_generate:${id}`;
  let { job } = await runtime.jobRepo.createOrReuse({
    kind: "cover_generate",
    runId: id,
    idempotencyKey: baseKey,
    payloadJson: JSON.stringify({ runId: id }),
  });
  if (job.status === "succeeded" || job.status === "failed") {
    // 上次作业已是终态（如生成失败）：换新幂等键重建，允许再次尝试
    ({ job } = await runtime.jobRepo.createOrReuse({
      kind: "cover_generate",
      runId: id,
      idempotencyKey: `${baseKey}:${Date.now()}`,
      payloadJson: JSON.stringify({ runId: id }),
    }));
  }

  return NextResponse.json(
    { jobId: job.id, hint: "封面生成中，约 1–2 分钟，稍后刷新查看" },
    { status: 202 },
  );
}
