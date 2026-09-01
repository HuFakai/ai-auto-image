import path from "node:path";
import { toAiError, withModelFallbacks, type VisualQualityModel } from "@aai/ai-core";
import type { CreateRunInput, GeneratedImage, Storyboard, StoryboardSlide } from "@aai/shared-schemas";
import type { AssetRepo, JobRepo, ProviderRepo, RevisionRepo, RunRepo, AssetStore } from "@aai/storage";
import { applyBrandOverlays, hasBrandOverlays } from "@aai/render-engine";
import type { ImageRoute } from "./knowledge-cards";
import { buildSlidePrompt } from "../prompts";
import { logger } from "../logger";
import type { JobRunner } from "../job-runner";
import { releaseReservedCredits } from "./credit-reservation";
import { maxRouteCredits, routeCreditsPerCall, selectWorkflowRoutes } from "../route-selection";

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
  assetsDir: string;
  visualQuality: VisualQualityModel | null;
  /** 可选计费回调：返修 Provider 调用前预留 1 点 */
  reserveImageCredits?: (runId: string, amount: number) => Promise<void>;
  /** 可选计费回调：返修成功/失败后释放未结算额度 */
  releaseImageCredits?: (runId: string) => Promise<void>;
}

async function loadStoryboard(deps: PageRegenDeps, runId: string): Promise<Storyboard> {
  const nodes = await deps.runRepo.listNodeRuns(runId);
  const node = nodes.find((n) => n.nodeName === "generate-storyboard" && n.status === "succeeded");
  if (!node?.outputRef) throw new Error("storyboard not found for run");
  // LLM 可能输出 1-based 页码：按数组下标归一化，与图片资产对齐
  const storyboard = (JSON.parse(node.outputRef) as { value: Storyboard }).value;
  storyboard.slides.forEach((slide, index) => {
    slide.index = index;
  });
  return storyboard;
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
 * 返修节点在资产和版本已经落库后若只因计费钩子失败，重试时复用该资产，
 * 仅再次执行结算，避免重复调用图片 Provider。
 */
async function retryExistingRegenOutput(
  deps: PageRegenDeps,
  runId: string,
  pageIndex: number,
): Promise<boolean> {
  const current = await deps.assetRepo.latestForPage(runId, pageIndex);
  if (!current || !current.nodeRunId || (current.kind !== "generated" && current.kind !== "composite")) return false;
  const nodes = await deps.runRepo.listNodeRuns(runId);
  const node = nodes.find((row) => row.id === current.nodeRunId && row.status === "failed" && row.outputRef);
  if (!node?.outputRef) return false;
  try {
    const output = JSON.parse(node.outputRef) as { assetId?: string };
    if (output.assetId !== current.id) return false;
  } catch {
    return false;
  }

  let reserved = false;
  try {
    if (deps.reserveImageCredits) {
      await deps.reserveImageCredits(runId, maxRouteCredits(deps.imageRoutes));
      reserved = true;
    }
    await deps.runRepo.succeedNode(node.id, {
      outputRef: node.outputRef,
      images: 1,
      credits: assetCredits(current.metadataJson),
    });
    await deps.runRepo.setReview(runId, "pending");
    logger.info("page regen billing retry reused asset", { runId, page: pageIndex, assetId: current.id });
    return true;
  } finally {
    if (reserved) {
      await releaseReservedCredits(deps, runId, (releaseError) =>
        logger.error("release page regen retry credits failed", { runId, error: String(releaseError) }),
      );
    }
  }
}

/** 失败作品补齐最后一页后恢复顶层状态；普通成功作品保持原有成功状态。 */
async function restoreRunStatusIfComplete(
  deps: PageRegenDeps,
  runId: string,
  input: CreateRunInput,
  storyboard: Storyboard,
): Promise<void> {
  const run = await deps.runRepo.require(runId);
  if (run.status !== "running" && run.status !== "failed") return;
  for (const slide of storyboard.slides) {
    if (!(await deps.assetRepo.latestForPage(runId, slide.index))) return;
  }
  await deps.runRepo.updateStatus(
    runId,
    input.requireApproval ? "awaiting_approval" : "succeeded",
    { errorSummary: null },
  );
}

/**
 * 单页返修：只重生成目标页，模型直接输出包含中文内容的完整图片，
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
    let runDeps: PageRegenDeps;
    try {
      const selected = selectWorkflowRoutes(input, [], deps.imageRoutes);
      runDeps = { ...deps, imageRoutes: selected.imageRoutes };
    } catch (error) {
      await deps.runRepo.updateStatus(ctx.runId, "failed", { errorSummary: String(error).slice(0, 400) });
      throw error;
    }
    await deps.runRepo.updateStatus(ctx.runId, "running");

    const slide: StoryboardSlide = {
      ...original,
      headline: payload.headline?.trim() || original.headline,
      body: payload.body ?? original.body,
    };
    if (await retryExistingRegenOutput(runDeps, ctx.runId, payload.pageIndex)) {
      await restoreRunStatusIfComplete(runDeps, ctx.runId, input, storyboard);
      return;
    }
    const plan = payload.imagePromptOverride
      ? { imagePrompt: payload.imagePromptOverride, expectedCopy: [slide.headline, ...slide.body] }
      : buildSlidePrompt(slide, storyboard, input);

    const node = await runDeps.runRepo.createNodeRun(ctx.runId, "generate-images");
    await runDeps.runRepo.startNode(node.id, {
      routeId: runDeps.imageRoutes[0]?.config.id,
      model: runDeps.imageRoutes[0]?.model,
    });

    let reserved = false;
    try {
      if (runDeps.reserveImageCredits) {
        await runDeps.reserveImageCredits(ctx.runId, maxRouteCredits(runDeps.imageRoutes));
        reserved = true;
      }
      let usedRoute: ImageRoute | null = null;
      const result = await withModelFallbacks({
        routes: runDeps.imageRoutes.map((route) => ({ config: route.config, model: route.model })),
        signal: ctx.signal,
        run: async (fallbackRoute) => {
          const route = runDeps.imageRoutes.find((r) => r.config.id === fallbackRoute.config.id)!;
          ctx.onProgress();
          const images = await route.image.generate({
            prompt: plan.imagePrompt,
            aspectRatio: input.aspectRatio,
            n: 1,
            signal: ctx.signal,
          });
          usedRoute = route;
          return images;
        },
        onAttempt: async (record) => {
          await runDeps.providerRepo.recordAttempt({
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
      const version = (await runDeps.assetRepo.pageVersionCount(ctx.runId, payload.pageIndex)) + 1;

      /* 模型出完整图，直接作为新版本 */
      await syncStoryboardSlide(runDeps, ctx.runId, payload.pageIndex, slide);
      const relPath = path.join("runs", ctx.runId, "pages", `page-${payload.pageIndex}-v${version}.png`);
      let imageToSave: GeneratedImage = image;
      if (hasBrandOverlays(input.brandKit)) {
        imageToSave = await overlayGeneratedImage(image, input.brandKit);
      }
      const saved = await runDeps.assetStore.saveGeneratedImage(imageToSave, relPath);
      await runDeps.assetRepo.supersedePage(ctx.runId, payload.pageIndex);
      const asset = await runDeps.assetRepo.create({
        runId: ctx.runId,
        nodeRunId: node.id,
        pageIndex: payload.pageIndex,
        kind: "generated",
        filePath: saved.filePath,
        mimeType: saved.mimeType,
        bytes: saved.bytes,
        checksum: saved.checksum,
        metadataJson: JSON.stringify({
          expectedCopy: plan.expectedCopy,
          revision: version,
          creditsPerCall: routeCreditsPerCall(usedRoute ?? runDeps.imageRoutes[0] ?? {}),
        }),
      });
      await runDeps.revisionRepo.create({
        runId: ctx.runId,
        pageIndex: payload.pageIndex,
        kind: "page-regen",
        payloadJson: JSON.stringify(payload),
        assetId: asset.id,
      });
      await runDeps.runRepo.succeedNode(node.id, {
        outputRef: JSON.stringify({ pageIndex: payload.pageIndex, assetId: asset.id, revision: version }),
        images: 1,
        credits: routeCreditsPerCall(usedRoute ?? runDeps.imageRoutes[0] ?? {}),
      });
      await runDeps.runRepo.setReview(ctx.runId, "pending");
      await restoreRunStatusIfComplete(runDeps, ctx.runId, input, storyboard);
      logger.info("page regenerated", { runId: ctx.runId, page: payload.pageIndex, version });
    } catch (error) {
      const aiError = toAiError(error);
      await runDeps.runRepo.failNode(node.id, aiError.category, aiError.message.slice(0, 400), {
        outputRef: JSON.stringify({ pageIndex: payload.pageIndex }),
      });
      await runDeps.runRepo.updateStatus(ctx.runId, "failed", {
        errorSummary: aiError.message.slice(0, 400),
      });
      throw error;
    } finally {
      if (reserved) {
        await releaseReservedCredits(runDeps, ctx.runId, (releaseError) =>
          logger.error("release page regen credits failed", { runId: ctx.runId, error: String(releaseError) }),
        );
      }
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

function assetCredits(metadataJson: string | null): number | undefined {
  try {
    const value = (JSON.parse(metadataJson ?? "{}") as { creditsPerCall?: unknown }).creditsPerCall;
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
