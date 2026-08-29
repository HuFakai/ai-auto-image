import fs from "node:fs";
import path from "node:path";
import { toAiError, withModelFallbacks, type VisualQualityModel } from "@aai/ai-core";
import type { CreateRunInput, GeneratedImage, Storyboard, StoryboardSlide } from "@aai/shared-schemas";
import type { AssetRepo, JobRepo, ProviderRepo, RevisionRepo, RunRepo, AssetStore } from "@aai/storage";
import { applyBrandOverlays, hasBrandOverlays, renderSlideDeterministic, themeById } from "@aai/render-engine";
import type { ImageRoute } from "./knowledge-cards";
import { buildSlidePrompt } from "../prompts";
import { logger } from "../logger";
import type { JobRunner } from "../job-runner";

export const PAGE_REGEN_KIND = "page_regen";

export interface PageRegenPayload {
  pageIndex: number;
  /** 覆盖后的文案（缺省沿用原稿） */
  headline?: string | undefined;
  body?: string[] | undefined;
  /** 覆盖画面 Prompt（缺省按 visualIntent 重建） */
  imagePromptOverride?: string | undefined;
}

export interface PageRegenDeps {
  runRepo: RunRepo;
  jobRepo: JobRepo;
  assetRepo: AssetRepo;
  providerRepo: ProviderRepo;
  revisionRepo: RevisionRepo;
  assetStore: AssetStore;
  imageRoutes: ImageRoute[];
  imageApiSemaphore: { run: <T>(fn: () => Promise<T>) => Promise<T> };
  postprocessMax: number;
  assetsDir: string;
  visualQuality: VisualQualityModel | null;
}

async function loadStoryboard(deps: PageRegenDeps, runId: string): Promise<Storyboard> {
  const nodes = await deps.runRepo.listNodeRuns(runId);
  const node = nodes.find((n) => n.nodeName === "generate-storyboard" && n.status === "succeeded");
  if (!node?.outputRef) throw new Error("storyboard not found for run");
  return (JSON.parse(node.outputRef) as { value: Storyboard }).value;
}

/** 返修成功后把新文案同步回 Storyboard，保证详情/导出与图片一致 */
async function syncStoryboardSlide(
  deps: PageRegenDeps,
  runId: string,
  pageIndex: number,
  slide: StoryboardSlide,
): Promise<void> {
  const nodes = await deps.runRepo.listNodeRuns(runId);
  const node = nodes.find((n) => n.nodeName === "generate-storyboard" && n.status === "succeeded");
  if (!node?.outputRef) return;
  try {
    const wrapper = JSON.parse(node.outputRef) as { value: Storyboard };
    const target = wrapper.value.slides[pageIndex];
    if (!target) return;
    target.headline = slide.headline;
    target.body = slide.body;
    await deps.runRepo.setNodeOutput(node.id, JSON.stringify(wrapper));
  } catch {
    /* 同步失败不影响返修结果 */
  }
}

/**
 * 单页返修：只重生成目标页（native 重出图；deterministic 重出视觉层并重新排版），
 * 旧版本资产保留（superseded），写入 Revision 版本链，其余页面零调用。
 */
export function registerPageRegenPipeline(runner: JobRunner, deps: PageRegenDeps): void {
  runner.register(PAGE_REGEN_KIND, async (ctx) => {
    const job = await deps.jobRepo.require(ctx.jobId);
    if (!ctx.runId || !job.payloadJson) throw new Error("page_regen requires runId and payload");
    const payload = JSON.parse(job.payloadJson) as PageRegenPayload;
    const run = await deps.runRepo.require(ctx.runId);
    const input = JSON.parse(run.inputJson) as CreateRunInput;
    const storyboard = await loadStoryboard(deps, ctx.runId);
    const original = storyboard.slides[payload.pageIndex];
    if (!original) throw new Error(`page index out of range: ${payload.pageIndex}`);

    const slide: StoryboardSlide = {
      ...original,
      headline: payload.headline?.trim() || original.headline,
      body: payload.body ?? original.body,
    };
    const mode = input.textRenderingMode;
    const plan = payload.imagePromptOverride
      ? { imagePrompt: payload.imagePromptOverride, expectedCopy: [slide.headline, ...slide.body] }
      : buildSlidePrompt(slide, storyboard, input, mode);

    const node = await deps.runRepo.createNodeRun(ctx.runId, "generate-images");
    await deps.runRepo.startNode(node.id, {
      routeId: deps.imageRoutes[0]?.config.id,
      model: deps.imageRoutes[0]?.model,
    });

    try {
      const result = await withModelFallbacks({
        routes: deps.imageRoutes.map((route) => ({ config: route.config, model: route.model })),
        signal: ctx.signal,
        run: async (fallbackRoute) => {
          const route = deps.imageRoutes.find((r) => r.config.id === fallbackRoute.config.id)!;
          return deps.imageApiSemaphore.run(async () => {
            ctx.onProgress();
            const images = await route.image.generate({
              prompt: plan.imagePrompt,
              aspectRatio: input.aspectRatio,
              n: 1,
              signal: ctx.signal,
            });
            return images;
          });
        },
        onAttempt: async (record) => {
          await deps.providerRepo.recordAttempt({
            runId: ctx.runId!,
            nodeRunId: node.id,
            routeId: record.routeId,
            kind: record.kind,
            model: record.model,
            attempt: record.attempt,
            statusCode: record.statusCode,
            errorCategory: record.errorCategory as never,
            errorSummary: record.errorSummary,
            providerRequestId: record.providerRequestId,
            startedAt: record.startedAt,
            finishedAt: record.finishedAt,
          });
        },
      });

      const image = result[0]!;
      const version = (await deps.assetRepo.pageVersionCount(ctx.runId, payload.pageIndex)) + 1;

      /* deterministic：AI 只出视觉层，文字由程序重新排版合成 */
      if (mode === "deterministic") {
        const visualRel = path.join("runs", ctx.runId, "pages", `page-${payload.pageIndex}-v${version}-visual.png`);
        const visualSaved = await deps.assetStore.saveGeneratedImage(image, visualRel);
        const visualBase64 = fs.readFileSync(visualSaved.filePath).toString("base64");
        const logoBase64 = await readLogoBase64(deps, input);
        const composite = await renderSlideDeterministic({
          theme: themeById(input.brandKit?.themeId),
          aspectRatio: input.aspectRatio,
          slide,
          pageCount: storyboard.slides.length,
          visualImageBase64: visualBase64,
          logoBase64,
          brand: input.brandKit,
        });
        await finishRegen(deps, ctx, {
          runId: ctx.runId,
          input,
          slide,
          payload,
          node,
          buffer: composite,
          version,
        });
        return;
      }

      /* native：模型出完整图，直接作为新版本 */
      await syncStoryboardSlide(deps, ctx.runId, payload.pageIndex, slide);
      const relPath = path.join("runs", ctx.runId, "pages", `page-${payload.pageIndex}-v${version}.png`);
      let imageToSave: GeneratedImage = image;
      if (hasBrandOverlays(input.brandKit)) {
        imageToSave = await overlayGeneratedImage(image, input.brandKit);
      }
      const saved = await deps.assetStore.saveGeneratedImage(imageToSave, relPath);
      await deps.assetRepo.supersedePage(ctx.runId, payload.pageIndex);
      const asset = await deps.assetRepo.create({
        runId: ctx.runId,
        nodeRunId: node.id,
        pageIndex: payload.pageIndex,
        kind: "generated",
        filePath: saved.filePath,
        mimeType: saved.mimeType,
        bytes: saved.bytes,
        checksum: saved.checksum,
        metadataJson: JSON.stringify({
          mode,
          expectedCopy: plan.expectedCopy,
          revision: version,
        }),
      });
      await deps.revisionRepo.create({
        runId: ctx.runId,
        pageIndex: payload.pageIndex,
        kind: "page-regen",
        payloadJson: JSON.stringify({ ...payload, mode }),
        assetId: asset.id,
      });
      await deps.runRepo.succeedNode(node.id, {
        outputRef: JSON.stringify({ pageIndex: payload.pageIndex, assetId: asset.id, revision: version }),
        images: 1,
      });
      await deps.runRepo.setReview(ctx.runId, "pending");
      logger.info("page regenerated", { runId: ctx.runId, page: payload.pageIndex, version });
    } catch (error) {
      const aiError = toAiError(error);
      await deps.runRepo.failNode(node.id, aiError.category, aiError.message.slice(0, 400));
      throw error;
    }
  });
}

/**
 * 对原生直出图叠加 Brand Kit 水印/签名（「只对 generated 直出图叠加」规则）。
 * 仅 base64 直出可叠加；URL 直出不下载，跳过叠加并原样返回。
 */
async function overlayGeneratedImage(
  image: GeneratedImage,
  brand: CreateRunInput["brandKit"],
): Promise<GeneratedImage> {
  const b64 = image.base64 ?? null;
  if (!b64) return image;
  const raw = Buffer.from(b64.replace(/^data:[^,]+,/, ""), "base64");
  try {
    const overlaid = await applyBrandOverlays(raw, brand);
    return { ...image, base64: overlaid.toString("base64") };
  } catch {
    return image;
  }
}

/** 读取 Brand Kit Logo（缺失或读取失败时返回 undefined，不阻塞渲染） */
async function readLogoBase64(deps: PageRegenDeps, input: CreateRunInput): Promise<string | undefined> {
  const logoAssetId = input.brandKit?.logoAssetId;
  if (!logoAssetId) return undefined;
  try {
    const asset = await deps.assetRepo.require(logoAssetId);
    return fs.readFileSync(deps.assetStore.resolve(asset.filePath)).toString("base64");
  } catch {
    return undefined;
  }
}

async function finishRegen(
  deps: PageRegenDeps,
  ctx: { runId: string | null; signal: AbortSignal; onProgress: () => void },
  args: {
    runId: string;
    input: CreateRunInput;
    slide: StoryboardSlide;
    payload: PageRegenPayload;
    node: { id: string };
    buffer: Buffer;
    version: number;
  },
): Promise<void> {
  await syncStoryboardSlide(deps, args.runId, args.payload.pageIndex, args.slide);
  const relPath = path.join("runs", args.runId, "pages", `page-${args.payload.pageIndex}-v${args.version}.png`);
  const saved = await deps.assetStore.saveBuffer(args.buffer, relPath);
  await deps.assetRepo.supersedePage(args.runId, args.payload.pageIndex);
  const asset = await deps.assetRepo.create({
    runId: args.runId,
    nodeRunId: args.node.id,
    pageIndex: args.payload.pageIndex,
    kind: "composite",
    filePath: saved.filePath,
    mimeType: saved.mimeType,
    bytes: saved.bytes,
    checksum: saved.checksum,
    metadataJson: JSON.stringify({
      mode: "deterministic",
      expectedCopy: [args.slide.headline, ...args.slide.body],
      revision: args.version,
    }),
  });
  await deps.revisionRepo.create({
    runId: args.runId,
    pageIndex: args.payload.pageIndex,
    kind: "page-regen",
    payloadJson: JSON.stringify({ ...args.payload, mode: "deterministic" }),
    assetId: asset.id,
  });
  await deps.runRepo.succeedNode(args.node.id, {
    outputRef: JSON.stringify({ pageIndex: args.payload.pageIndex, assetId: asset.id, revision: args.version }),
    images: 1,
  });
  await deps.runRepo.setReview(args.runId, "pending");
  void ctx;
  logger.info("page regenerated (deterministic)", { runId: args.runId, page: args.payload.pageIndex, version: args.version });
}
