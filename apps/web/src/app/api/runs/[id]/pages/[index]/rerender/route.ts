import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { CreateRunInput, Storyboard, StoryboardSlide } from "@aai/shared-schemas";
import { renderSlideDeterministic, themeById } from "@aai/render-engine";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";
import { requireCredits } from "@/server/billing";

export const dynamic = "force-dynamic";

const RerenderSchema = z.object({
  headline: z.string().min(1).max(200),
  body: z.array(z.string().max(500)).max(6),
});

/**
 * 确定性模式专属：只改文案、重新排版（零模型调用、零费用）。
 * native 模式请使用 regenerate（需重新出图）。
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; index: string }> },
) {
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
  const parsed = RerenderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }

  // 计费预检：返修重出一张图消耗 1 点
  const billingGuard = await requireCredits(user.id, 1);
  if (billingGuard) return billingGuard;

  const runtime = await getRuntime();
  const run = await runtime.runRepo.require(id);
  if (run.userId && run.userId !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const input = JSON.parse(run.inputJson) as CreateRunInput;
  if (input.textRenderingMode !== "deterministic") {
    return NextResponse.json(
      { error: "rerender only applies to deterministic runs; use regenerate" },
      { status: 409 },
    );
  }

  // Brand Kit Logo 归属校验：logoAssetId 对应资产存在时，必须是上传素材
  // （runId 为空）或属于当前用户（资产→run→userId）；admin 放行，否则 403
  if (input.brandKit?.logoAssetId) {
    const logoAsset = await runtime.assetRepo.require(input.brandKit.logoAssetId).catch(() => null);
    if (logoAsset) {
      let owned = logoAsset.runId === null;
      if (!owned && logoAsset.runId) {
        const ownerRun = await runtime.runRepo.require(logoAsset.runId).catch(() => null);
        owned = Boolean(ownerRun?.userId && ownerRun.userId === user.id);
      }
      if (!owned && user.role !== "admin") {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
  }

  // Storyboard 与页面
  const storyboardNode = (await runtime.runRepo.listNodeRuns(id)).find(
    (n) => n.nodeName === "generate-storyboard" && n.status === "succeeded",
  );
  if (!storyboardNode?.outputRef) return NextResponse.json({ error: "storyboard missing" }, { status: 409 });
  const storyboard = (JSON.parse(storyboardNode.outputRef) as { value: Storyboard }).value;
  const original = storyboard.slides[pageIndex];
  if (!original) return NextResponse.json({ error: "page index out of range" }, { status: 404 });

  const slide: StoryboardSlide = { ...original, headline: parsed.data.headline, body: parsed.data.body };

  // 视觉层沿用当前版本，文字重排。
  // latestForPage 可能返回 composite（deterministic 合成本身未 supersede 时是"最新"），
  // 二次排版必须基于无文字的 generated 视觉层，否则新文案会叠在旧文案已渲染的图上。
  let visualAsset = await runtime.assetRepo.latestForPage(id, pageIndex);
  if (!visualAsset || visualAsset.kind !== "generated") {
    const rows = await runtime.assetRepo.listByRun(id);
    const live = rows
      .filter((row) => row.pageIndex === pageIndex && row.kind === "generated" && row.supersededAt === null)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    visualAsset = live
      ?? rows
        // 连续多次 rerender 时：supersedePage 会把整页资产（含 generated 视觉层）置为 superseded，
        // 视觉层本身从未变化，回退到该页最新 generated 资产，避免二次重排 404
        .filter((row) => row.pageIndex === pageIndex && row.kind === "generated")
        .sort((a, b) => b.createdAt - a.createdAt)[0];
  }
  if (!visualAsset) return NextResponse.json({ error: "visual asset not found" }, { status: 404 });
  const visualBase64 = fs
    .readFileSync(runtime.assetStore.resolve(visualAsset.filePath))
    .toString("base64");
  const logoBase64 = input.brandKit?.logoAssetId
    ? await (async () => {
        try {
          return fs
            .readFileSync(
              runtime.assetStore.resolve((await runtime.assetRepo.require(input.brandKit!.logoAssetId!)).filePath),
            )
            .toString("base64");
        } catch {
          return undefined;
        }
      })()
    : undefined;

  const buffer = await renderSlideDeterministic({
    theme: themeById(input.brandKit?.themeId),
    aspectRatio: input.aspectRatio,
    slide,
    pageCount: storyboard.slides.length,
    visualImageBase64: visualBase64,
    logoBase64,
    brand: input.brandKit,
  });

  // 同步回写 Storyboard，保证详情/导出与新文案一致
  if (storyboardNode?.outputRef) {
    try {
      const wrapper = JSON.parse(storyboardNode.outputRef) as { value: Storyboard };
      const target = wrapper.value.slides[pageIndex];
      if (target) {
        target.headline = slide.headline;
        target.body = slide.body;
        await runtime.runRepo.setNodeOutput(storyboardNode.id, JSON.stringify(wrapper));
      }
    } catch {
      /* 同步失败不影响重排结果 */
    }
  }

  const version = (await runtime.assetRepo.pageVersionCount(id, pageIndex)) + 1;
  const saved = await runtime.assetStore.saveBuffer(
    buffer,
    path.join("runs", id, "pages", `page-${pageIndex}-v${version}.png`),
  );
  await runtime.assetRepo.supersedePage(id, pageIndex);
  const asset = await runtime.assetRepo.create({
    runId: id,
    pageIndex,
    kind: "composite",
    filePath: saved.filePath,
    mimeType: saved.mimeType,
    bytes: saved.bytes,
    checksum: saved.checksum,
    metadataJson: JSON.stringify({
      mode: "deterministic",
      expectedCopy: [slide.headline, ...slide.body],
      revision: version,
    }),
  });
  await runtime.revisionRepo.create({
    runId: id,
    pageIndex,
    kind: "rerender",
    payloadJson: JSON.stringify({ headline: slide.headline, body: slide.body }),
    assetId: asset.id,
  });
  await runtime.runRepo.setReview(id, "pending");

  return NextResponse.json({ assetId: asset.id, revision: version }, { status: 201 });
}
