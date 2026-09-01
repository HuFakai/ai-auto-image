import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { NextResponse } from "next/server";
import type { CreateRunInput } from "@aai/shared-schemas";
import { toBeijingIsoString } from "@aai/shared-schemas";
import { routeCreditsPerCall, selectWorkflowRoutes } from "@aai/workflow-engine";
import { z } from "zod";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";
import { insufficientCreditsResponse, InsufficientCreditsError } from "@/server/billing";

export const dynamic = "force-dynamic";

const RepaintSchema = z.object({
  /** 归一化重绘区域（0–1，相对整页） */
  rect: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0.01).max(1),
    h: z.number().min(0.01).max(1),
  }),
  /** 区域内要画什么/改成什么 */
  prompt: z.string().min(1).max(2000),
});

/**
 * 局部重绘（Mask 框架）：
 * 1. 构建透明区域 Mask（目标区域 alpha=0，其余不透明）；
 * 2. 调用支持图生图的渠道执行带 Mask 的编辑；
 * 3. 渠道不支持 Mask 时降级为整页重绘提示（前端引导用 regenerate）。
 * UI 框选组件后续接入；当前 API 即数据链路（docs/03 3.5）。
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string; index: string }> }) {
  const { id, index } = await ctx.params;
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const pageIndex = Number.parseInt(index, 10);
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    return NextResponse.json({ error: "invalid page index" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = RepaintSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }

  const runtime = await getRuntime();
  const run = await runtime.runRepo.require(id);
  if (run.userId && run.userId !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const input = JSON.parse(run.inputJson) as CreateRunInput;
  const current = await runtime.assetRepo.latestForPage(id, pageIndex);
  if (!current) return NextResponse.json({ error: "page asset missing" }, { status: 409 });

  // 构建 Mask：目标区域透明（=重绘），其余不透明
  const sourceBuffer = fs.readFileSync(runtime.assetStore.resolve(current.filePath));
  const meta = await sharp(sourceBuffer).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const { x, y, w, h } = parsed.data.rect;
  const mask = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .composite([
      {
        input: {
          create: {
            width: Math.max(8, Math.round(width * w)),
            height: Math.max(8, Math.round(height * h)),
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        },
        left: Math.round(width * x),
        top: Math.round(height * y),
      },
    ])
    .png()
    .toBuffer();

  // 读取 Mask 编辑路由并执行（运行时管线内的 imageRoutes 由 runner 快照持有；
  // 这里直接通过渠道服务装配一条编辑路由）
  const assembled = await runtime.channelService.assembleRoutes();
  let imageRoutes: typeof assembled.imageRoutes;
  try {
    imageRoutes = selectWorkflowRoutes(input, [], assembled.imageRoutes).imageRoutes;
  } catch {
    return NextResponse.json({ error: "作品绑定的图片模型当前不可用，请检查模型渠道后重试" }, { status: 409 });
  }
  const route = imageRoutes.find((r) => r.image.capabilities().imageEditSingle);
  if (!route) {
    return NextResponse.json({ error: "没有可用图生图路由" }, { status: 409 });
  }

  let reserved = false;
  try {
    // 与异步管线一致：先原子预留，再调用 Provider；失败/取消会释放预留。
    const credits = routeCreditsPerCall(route);
    await runtime.billing.reserveRunCredits(user.id, id, credits);
    reserved = true;

    // 渠道模型实例已统一绑定渠道级并发门；这里仅组合超时与客户端取消信号。
    const timeoutSignal = AbortSignal.timeout(120_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
    const images = await route.image.edit!({
      prompt: `${parsed.data.prompt}。只修改 Mask 指示的区域，区域外内容必须保持原样。`,
      aspectRatio: input.aspectRatio,
      baseImage: { base64: sourceBuffer.toString("base64") },
      maskBase64: mask.toString("base64"),
      signal,
    });
    const image = images[0]!;

    const version = (await runtime.assetRepo.pageVersionCount(id, pageIndex)) + 1;
    const saved = await runtime.assetStore.saveGeneratedImage(
      image,
      path.join("runs", id, "pages", `page-${pageIndex}-v${version}.png`),
    );
    await runtime.assetRepo.supersedePage(id, pageIndex);
    const asset = await runtime.assetRepo.create({
      runId: id,
      pageIndex,
      kind: "generated",
      filePath: saved.filePath,
      mimeType: saved.mimeType,
      bytes: saved.bytes,
      checksum: saved.checksum,
      metadataJson: JSON.stringify({
        repaint: { rect: parsed.data.rect, prompt: parsed.data.prompt },
        revision: version,
        model: route.model,
        creditsPerCall: credits,
      }),
    });
    // 资产已经落库后结算本次真实成功图片；finally 释放未结算预留。
    await runtime.billing.consumeForImages(user.id, id, 1, "workflow_repaint", `${id}:${pageIndex}:v${version}`, credits);
    await runtime.revisionRepo.create({
      runId: id,
      pageIndex,
      kind: "repaint",
      payloadJson: JSON.stringify({ rect: parsed.data.rect, prompt: parsed.data.prompt }),
      assetId: asset.id,
    });
    await runtime.runRepo.setReview(id, "pending");

    return NextResponse.json({ assetId: asset.id, revision: version }, { status: 201 });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) return insufficientCreditsResponse(error);
    throw error;
  } finally {
    if (reserved) {
      await runtime.billing.releaseRunCredits(id).catch((releaseError) => {
        console.log(JSON.stringify({ ts: toBeijingIsoString(), level: "error", msg: "repaint credit release failed", id, error: String(releaseError) }));
      });
    }
  }
}
