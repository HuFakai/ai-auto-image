import { NextResponse } from "next/server";
import { CreateRunInputSchema } from "@aai/shared-schemas";
import { getRuntime } from "@/server/runtime";
import { listRunItems } from "@/server/run-views";
import type { RunListItem } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = CreateRunInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues.slice(0, 5) },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const runtime = getRuntime();
  const effective = runtime.effectiveConcurrency(input.requestedImageConcurrency);
  const project = runtime.projectRepo.create({ title: input.topic.slice(0, 60) });
  const run = runtime.runRepo.create({ projectId: project.id, inputJson: JSON.stringify(input) });
  const { job } = runtime.jobRepo.createOrReuse({
    kind: "knowledge_card_run",
    runId: run.id,
    // 幂等键：同一 Run 的生成操作天然幂等
    idempotencyKey: `knowledge_card:${run.id}`,
    maxAttempts: 3,
  });
  runtime.jobRepo.appendEvent(job.id, "created", `run=${run.id}`);

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
  const runtime = getRuntime();
  const runs: RunListItem[] = listRunItems(runtime, 20);
  return NextResponse.json({
    runs,
    providerLabel: runtime.config.providerLabel,
    providerMode: runtime.config.providerMode,
    serverMaxConcurrency: runtime.config.serverMaxConcurrency,
    defaultConcurrency: runtime.config.defaultConcurrency,
  });
}
