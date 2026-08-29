import { NextResponse } from "next/server";
import type { BrandKitConfig, ThemeId } from "@aai/shared-schemas";
import { CreateRunInputSchema } from "@aai/shared-schemas";
import { getRuntime } from "@/server/runtime";
import { listRunItems } from "@/server/run-views";
import type { RunListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Brand Kit：按 id 解析配置快照（创建时冻结进 run input）
  const brandKitId = typeof body.brandKitId === "string" ? body.brandKitId : undefined;
  let brandKit: BrandKitConfig | undefined;
  if (brandKitId) {
    try {
      const kit = await (await getRuntime()).brandKitRepo.require(brandKitId);
      brandKit = {
        themeId: kit.themeId as ThemeId,
        styleKeywords: JSON.parse(kit.styleKeywordsJson) as string[],
        negativeKeywords: JSON.parse(kit.negativeKeywordsJson) as string[],
        logoAssetId: kit.logoAssetId ?? undefined,
      };
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

  const runtime = await getRuntime();
  const effective = runtime.effectiveConcurrency(input.requestedImageConcurrency);
  const project = await runtime.projectRepo.create({ title: input.topic.slice(0, 60) });
  const run = await runtime.runRepo.create({ projectId: project.id, inputJson: JSON.stringify(input) });
  const jobKind = input.recipe === "comic_story" ? "comic_story_run" : "knowledge_card_run";
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
      requestedConcurrency: input.requestedImageConcurrency,
      effectiveConcurrency: effective,
    },
    { status: 201 },
  );
}

export async function GET() {
  const runtime = await getRuntime();
  const runs: RunListItem[] = await listRunItems(runtime, 20);
  return NextResponse.json({
    runs,
    providerLabel: runtime.config.providerLabel,
    providerMode: runtime.config.providerMode,
    serverMaxConcurrency: runtime.config.serverMaxConcurrency,
    defaultConcurrency: runtime.config.defaultConcurrency,
  });
}
