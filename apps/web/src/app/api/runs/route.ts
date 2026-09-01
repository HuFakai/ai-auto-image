import { NextResponse } from "next/server";
import type { BrandKitConfig } from "@aai/shared-schemas";
import { CreateRunInputSchema } from "@aai/shared-schemas";
import { brandKitConfigFromRow } from "@/server/brand-kit-views";
import { getRuntime } from "@/server/runtime";
import { listRunItems } from "@/server/run-views";
import { requireApiUser, userActionLimit } from "@/server/auth";
import { MIN_CREATION_CREDITS, requireCredits } from "@/server/billing";
import type { RunListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 创建 run 会产生真实推理/图片费用：每用户每分钟最多 10 次
  if (!userActionLimit(`create-run:${user.id}`, 10, 60_000)) {
    return NextResponse.json(
      { error: "操作过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // 创建准入预检：最低 6 点，防止低余额用户先创建出必然失败的空作品。
  // 真实消耗仍由工作流按实际模型调用逐次预留/结算。
  const billingGuard = await requireCredits(user.id, MIN_CREATION_CREDITS);
  if (billingGuard) return billingGuard;

  // Brand Kit：按 id 解析配置快照（创建时冻结进 run input，含水印/签名/色板/布局等新字段）
  const brandKitId = typeof body.brandKitId === "string" ? body.brandKitId : undefined;
  let brandKit: BrandKitConfig | undefined;
  if (brandKitId) {
    try {
      const kit = await (await getRuntime()).brandKitRepo.require(brandKitId);
      brandKit = brandKitConfigFromRow(kit);
    } catch {
      return NextResponse.json({ error: "brand kit not found" }, { status: 400 });
    }
  }

  const parsed = CreateRunInputSchema.safeParse({ ...body, ...(brandKit ? { brandKit } : {}) });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues.slice(0, 6) },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // 长文拆解（article_digest）必须提供参考资料正文：拆解是提炼原文，无原文无从拆解
  if (input.recipe === "article_digest" && !input.sourceText?.trim()) {
    return NextResponse.json(
      { error: "article_digest 需要参考资料正文（sourceText）才能拆解长文" },
      { status: 400 },
    );
  }

  const runtime = await getRuntime();
  const project = await runtime.projectRepo.create({ title: input.topic.slice(0, 60), userId: user.id });
  const run = await runtime.runRepo.create({
    projectId: project.id,
    inputJson: JSON.stringify(input),
    userId: user.id,
  });
  // 四格漫画与科普漫画共用 comic 管线；其余内容类型走知识卡片管线
  const jobKind =
    input.recipe === "comic_story" || input.recipe === "strip_comic"
      ? "comic_story_run"
      : "knowledge_card_run";
  const { job } = await runtime.jobRepo.createOrReuse({
    kind: jobKind,
    runId: run.id,
    idempotencyKey: `${jobKind}:${run.id}`,
    maxAttempts: 3,
  });
  await runtime.jobRepo.appendEvent(job.id, "created", `run=${run.id}`);

  return NextResponse.json(
    {
      runId: run.id,
      jobId: job.id,
    },
    { status: 201 },
  );
}

export async function GET() {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runtime = await getRuntime();
  const runs: RunListItem[] = await listRunItems(runtime, 20, user.role === "admin" ? null : user.id);
  return NextResponse.json({
    runs,
    providerLabel: runtime.config.providerLabel,
    providerMode: runtime.config.providerMode,
  });
}
