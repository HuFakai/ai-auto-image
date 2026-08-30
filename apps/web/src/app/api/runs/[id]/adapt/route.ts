import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { CreateRunInput, Storyboard } from "@aai/shared-schemas";
import { StoryboardSchema } from "@aai/shared-schemas";
import type { AdaptPlatform } from "@aai/shared-schemas";
import { buildAdaptationZip, buildPlatformAdaptation, templateCopy } from "@aai/workflow-engine";
import { getRuntime } from "@/server/runtime";
import { requireApiUser, userActionLimit } from "@/server/auth";

export const dynamic = "force-dynamic";

// xiaohongshu 是原始创作平台，不参与适配（直接用现有导出）
const AdaptSchema = z.object({
  platform: z.enum(["douyin", "wechat", "instagram"]),
});

/**
 * 多平台一键适配包（POST）：确定性模式零模型费用重排到目标平台比例。
 * 逐页取 generated 视觉层重新排版，产物为 ZIP（images/ + 发布文案.md + manifest.json），
 * 同时缓存一份到 exports/adapt/<runId>/。
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 适配本身零模型费用，但仍限流防滥用（渲染有 CPU 成本）
  if (!userActionLimit(`adapt:${user.id}`, 6, 60_000)) {
    return NextResponse.json(
      { error: "操作过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsedBody = AdaptSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "invalid platform" }, { status: 400 });
  }
  const targetPlatform = parsedBody.data.platform as AdaptPlatform;

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
  if (input.textRenderingMode !== "deterministic") {
    return NextResponse.json(
      { error: "native-mode", hint: "native 模式请以目标比例重新生成" },
      { status: 400 },
    );
  }

  // Storyboard（标题与页序），解析方式与导出路由一致
  const storyboardNode = (await runtime.runRepo.listNodeRuns(id)).find(
    (n) => n.nodeName === "generate-storyboard" && n.status === "succeeded",
  );
  if (!storyboardNode?.outputRef) {
    return NextResponse.json({ error: "storyboard missing" }, { status: 409 });
  }
  const parsedStoryboard = StoryboardSchema.safeParse(
    (JSON.parse(storyboardNode.outputRef) as { value: unknown }).value as Storyboard,
  );
  if (!parsedStoryboard.success) {
    return NextResponse.json({ error: "storyboard invalid" }, { status: 409 });
  }

  const result = await buildPlatformAdaptation(
    { assetRepo: runtime.assetRepo, assetStore: runtime.assetStore },
    { runId: id, input, storyboard: parsedStoryboard.data, targetPlatform },
  );
  if (result.skipped) {
    return NextResponse.json(
      { error: "same-aspect", hint: "原始比例与目标一致，请直接使用现有导出" },
      { status: 409 },
    );
  }
  if (result.pages.length === 0) {
    return NextResponse.json(
      { error: "no pages to export", missingPages: result.missingPages },
      { status: 409 },
    );
  }

  // 发布文案：沿用模板文案（零模型费用，标 source: template）
  const briefNode = (await runtime.runRepo.listNodeRuns(id)).find((n) => n.nodeName === "generate-brief");
  const coreMessage = briefNode?.outputRef
    ? (JSON.parse(briefNode.outputRef) as { value?: { coreMessage?: string } }).value?.coreMessage
    : undefined;
  const copy = templateCopy(input, parsedStoryboard.data.slides, coreMessage);

  const zip = await buildAdaptationZip({
    runId: id,
    topic: input.topic,
    targetPlatform,
    targetAspect: result.targetAspect,
    pages: result.pages,
    missingPages: result.missingPages,
    copy,
  });

  // 落一份缓存到 exports/adapt/<runId>/，重复下载不再重排
  const filename = `adapt-${targetPlatform}-${id.slice(4, 12)}.zip`;
  const adaptDir = path.join(runtime.config.exportsDir, "adapt", id);
  fs.mkdirSync(adaptDir, { recursive: true });
  fs.writeFileSync(path.join(adaptDir, filename), zip);

  return new Response(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      // 缺视觉层被跳过的页（逗号分隔页序），供前端提示
      "x-adapt-missing-pages": result.missingPages.join(","),
    },
  });
}
