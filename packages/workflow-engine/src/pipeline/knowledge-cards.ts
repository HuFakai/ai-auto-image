import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  ContentBriefSchema,
  StoryboardSchema,
  toBeijingIsoString,
  type ContentBrief,
  type CreateRunInput,
  type GeneratedImage,
  type ModelUsage,
  type ProviderRouteConfig,
  type Storyboard,
  type StoryboardSlide,
} from "@aai/shared-schemas";
import {
  toAiError,
  withModelFallbacks,
  type ImageModel,
  type TextModel,
  type VisualQualityModel,
} from "@aai/ai-core";
import type {
  AssetRepo,
  JobRepo,
  PromptRepo,
  ProviderRepo,
  RunRepo,
  AssetStore,
} from "@aai/storage";
import { applyBrandOverlays, hasBrandOverlays } from "@aai/render-engine";
import { logger } from "../logger";
import type { JobRunner } from "../job-runner";
import { buildBriefPrompt, buildSlidePrompt, buildStoryboardPrompt } from "../prompts";
import { runCoverStage } from "./cover";
import { releaseReservedCredits, reserveCreditsToTarget } from "./credit-reservation";
import { maxRouteCredits, routeCreditsPerCall, selectWorkflowRoutes } from "../route-selection";

export const KNOWLEDGE_CARD_KIND = "knowledge_card_run";

/** 已绑定文本模型的路由 */
export interface TextRoute {
  config: ProviderRouteConfig;
  model: string;
  text: TextModel;
  channelId?: string;
  channelModelId?: string;
  providerModelId?: string;
  creditsPerCall?: number;
}

/** 已绑定图片模型的路由 */
export interface ImageRoute {
  config: ProviderRouteConfig;
  model: string;
  image: ImageModel;
  channelId?: string;
  channelModelId?: string;
  providerModelId?: string;
  creditsPerCall?: number;
}

export interface WorkflowDeps {
  runRepo: RunRepo;
  jobRepo: JobRepo;
  promptRepo: PromptRepo;
  assetRepo: AssetRepo;
  providerRepo: ProviderRepo;
  assetStore: AssetStore;
  textRoutes: TextRoute[];
  imageRoutes: ImageRoute[];
  /** 原生模式下的文字审查模型（可选：无可用视觉模型时跳过检查） */
  visualQuality: VisualQualityModel | null;
  assetsDir: string;
  exportsDir: string;
  /** 可选计费回调：运行在首次调用图片 Provider 前预留额度 */
  reserveImageCredits?: (runId: string, amount: number) => Promise<void>;
  /** 可选计费回调：运行结束、失败或取消时释放未结算额度 */
  releaseImageCredits?: (runId: string) => Promise<void>;
  /** 文本模型调用前预留单次额度 */
  reserveModelCredits?: (runId: string, amount: number) => Promise<void>;
  /** 文本模型成功后结算单次额度 */
  captureModelCredits?: (runId: string, nodeRunId: string, amount: number, model?: string) => Promise<void>;
  /** 文本模型失败后释放本次额度 */
  releaseModelCredits?: (runId: string, amount: number) => Promise<void>;
}

interface NodeRowLike {
  id: string;
  nodeName: string;
  status: string;
  outputRef: string | null;
}

function succeededNode(rows: NodeRowLike[], nodeName: string): NodeRowLike | undefined {
  return rows.find((row) => row.nodeName === nodeName && row.status === "succeeded");
}

function succeededPageNode(rows: NodeRowLike[], pageIndex: number): NodeRowLike | undefined {
  return rows.find((row) => {
    if (row.nodeName !== "generate-images" || row.status !== "succeeded") return false;
    return pageIndexOf(row) === pageIndex;
  });
}

function pageIndexOf(row: NodeRowLike): number | undefined {
  try {
    return (JSON.parse(row.outputRef ?? "{}") as { pageIndex?: number }).pageIndex;
  } catch {
    return undefined;
  }
}

/**
 * 结算钩子失败后，节点可能仍保留已落盘图片。重试时优先复用该产物，
 * 只重新执行 succeedNode（从而重试计费钩子），避免再次调用图片 Provider。
 */
async function retryExistingImageNode(
  deps: WorkflowDeps,
  rows: NodeRowLike[],
  runId: string,
  pageIndex: number,
): Promise<boolean> {
  const node = rows.find(
    (row) => row.nodeName === "generate-images" && row.status === "failed" && pageIndexOf(row) === pageIndex,
  );
  if (!node?.outputRef) return false;
  let assetId: string | undefined;
  try {
    assetId = (JSON.parse(node.outputRef) as { assetId?: string }).assetId;
  } catch {
    return false;
  }
  if (!assetId) return false;
  const asset = await deps.assetRepo.require(assetId).catch(() => null);
  if (!asset || asset.runId !== runId || asset.pageIndex !== pageIndex || asset.supersededAt !== null) return false;
  let credits: number | undefined;
  try {
    const metadata = JSON.parse(asset.metadataJson ?? "{}") as { creditsPerCall?: unknown };
    if (typeof metadata.creditsPerCall === "number") credits = metadata.creditsPerCall;
  } catch {
    /* 历史资产没有价格快照时使用默认 1 点 */
  }
  await deps.runRepo.succeedNode(node.id, { outputRef: node.outputRef, images: 1, credits });
  return true;
}

/**
 * 阶段 0 Spike 流水线（docs/phases/00 §7）：
 * parse-input → generate-brief → generate-storyboard → generate-images（并行，渠道可选限流）
 * → package-export。
 *
 * 所有节点幂等：Job 重试或应用重启恢复时，已成功的节点与页面直接跳过，
 * 因此"单页失败仅重试该页"与"重启恢复不重跑已完成页面"天然成立。
 */
export function registerKnowledgeCardPipeline(runner: JobRunner, deps: WorkflowDeps): void {
  runner.register(KNOWLEDGE_CARD_KIND, async (ctx) => {
    if (!ctx.runId) throw new Error("knowledge_card_run requires runId");
    const run = await deps.runRepo.require(ctx.runId);
    const input = JSON.parse(run.inputJson) as CreateRunInput;
    await deps.runRepo.updateStatus(run.id, "running");

    try {
      const selected = selectWorkflowRoutes(input, deps.textRoutes, deps.imageRoutes);
      await executeKnowledgeCardRun({ ...deps, ...selected }, ctx, run.id, input);
    } catch (error) {
      // 中途取消发生在节点内部时，保证 Run 不停留在 running
      if (ctx.signal.aborted) {
        await deps.runRepo.updateStatus(run.id, "cancelled");
      } else {
        await deps.runRepo
          .updateStatus(run.id, "failed", { errorSummary: String(error).slice(0, 400) })
          .catch((statusError) => logger.error("run failure status update failed", { runId: run.id, error: String(statusError) }));
      }
      throw error;
    } finally {
      await releaseReservedCredits(deps, run.id, (releaseError) =>
        logger.error("release image credits failed", { runId: run.id, error: String(releaseError) }),
      );
    }
  });
}

/** 流水线主体（供外层取消兜底包裹） */
async function executeKnowledgeCardRun(
  deps: WorkflowDeps,
  ctx: { signal: AbortSignal; onProgress: () => void },
  runId: string,
  input: CreateRunInput,
): Promise<void> {
  const existingNodes = (await deps.runRepo.listNodeRuns(runId)) as unknown as NodeRowLike[];

    /* parse-input */
    if (!succeededNode(existingNodes, "parse-input")) {
      const node = await deps.runRepo.createNodeRun(runId, "parse-input");
      await deps.runRepo.startNode(node.id);
      await deps.runRepo.succeedNode(node.id, {
        outputRef: JSON.stringify({
          platform: input.platform,
          aspectRatio: input.aspectRatio,
        }),
      });
    }

    /* RunSnapshot：冻结渠道并发与路由 */
    await deps.runRepo.setSnapshot(
      runId,
      JSON.stringify({
        concurrency: {
          channels: [
            ...deps.textRoutes.map((route) => ({
              id: route.config.id,
              type: "text" as const,
              max: route.config.concurrencyMax,
            })),
            ...deps.imageRoutes.map((route) => ({
              id: route.config.id,
              type: "image" as const,
              max: route.config.concurrencyMax,
            })),
          ],
        },
        routes: [...deps.textRoutes, ...deps.imageRoutes].map((route) => ({
          id: route.config.id,
          kind: route.config.kind,
          model: route.model,
          channelModelId: route.channelModelId,
          creditsPerCall: routeCreditsPerCall(route),
        })),
      }),
    );

    /* generate-brief */
    const { value: brief } = await runStructuredNode(deps, ctx, runId, existingNodes, {
      nodeName: "generate-brief",
      schemaName: "ContentBrief",
      schema: ContentBriefSchema,
      buildPrompt: () => buildBriefPrompt(input),
    });
    await throwIfAborted(deps, runId, ctx.signal);

    /* generate-storyboard */
    const { value: storyboard, nodeId: storyboardNodeId } = await runStructuredNode(deps, ctx, runId, existingNodes, {
      nodeName: "generate-storyboard",
      schemaName: "Storyboard",
      schema: StoryboardSchema,
      buildPrompt: () => buildStoryboardPrompt(input, brief),
    });
    // LLM 可能输出 1-based 页码；统一归一化为 0-based，保证文件名、页码标签与顺序一致
    storyboard.slides.forEach((slide, index) => {
      slide.index = index;
    });
    // LLM 可能输出 1-based 页码：把归一化后的分镜写回节点，
    // 保证详情/导出/返修等消费方读到的 index 与图片资产一致
    await deps.runRepo.setNodeOutput(
      storyboardNodeId,
      JSON.stringify({ value: storyboard, schemaName: "Storyboard" }),
    );
    await throwIfAborted(deps, runId, ctx.signal);
    const pageCount = storyboard.slides.length;

    // 只为本次尚未结算的页面/封面预留额度。历史成功节点已经扣费，不能在重试时重复预留；
    // creditsCharged 还包含文本模型费用，因此不能再用运行总扣点反推图片完成量。
    const imageNodes = (await deps.runRepo.listNodeRuns(runId)) as unknown as NodeRowLike[];
    const pendingPageCount = storyboard.slides.filter((slide) => !succeededPageNode(imageNodes, slide.index)).length;
    const coverDone = imageNodes.some((row) => row.nodeName === "generate-covers" && row.status === "succeeded");
    const pendingCoverCount = input.generateCoverCandidates && !coverDone ? 3 : 0;
    const expectedImageCount = pendingPageCount + pendingCoverCount;
    await reserveCreditsToTarget(deps, runId, expectedImageCount * maxRouteCredits(deps.imageRoutes));

    /* generate-images：所有页面并行发起；模型渠道自身决定是否限流 */
    const failedPages: number[] = [];
    const pageTasks = storyboard.slides.map((slide) => async () => {
      const rows = (await deps.runRepo.listNodeRuns(runId)) as unknown as NodeRowLike[];
      if (succeededPageNode(rows, slide.index)) {
        return;
      }
      if (await retryExistingImageNode(deps, rows, runId, slide.index)) {
        return;
      }
      await generatePage(deps, ctx, runId, input, storyboard, slide, pageCount, failedPages);
    });
    await Promise.all(pageTasks.map((task) => task()));
    await throwIfAborted(deps, runId, ctx.signal);

    /* generate-covers：封面候选（增强能力，失败不阻塞；Comic 管线不做——漫画首页即封面）。
       仅当创作时勾选「生成封面候选」才自动生成；未开启可用详情页手动补生成。 */
    if (input.generateCoverCandidates) {
      await runCoverStage(deps, ctx, runId, input, storyboard);
    }

    /* package-export */
    const totals = await writeExportManifest(deps, runId, input, brief, storyboard, failedPages);

    if (failedPages.length > 0) {
      const summary = `pages failed: ${failedPages.join(", ")}`;
      await deps.runRepo.updateStatus(runId, "failed", { errorSummary: summary });
      throw new Error(summary);
    }
    if (input.requireApproval) {
      // 审批门：挂起等待人工确认（确认后由 review API 置 succeeded，导出才放行）
      await deps.runRepo.updateStatus(runId, "awaiting_approval");
      logger.info("run awaiting final approval", { runId, pages: pageCount });
      return;
    }
    await deps.runRepo.updateStatus(runId, "succeeded");
    logger.info("knowledge card run completed", {
      runId: runId,
      pages: pageCount,
      images: totals.images,
      costUsd: totals.costUsd,
    });
}

async function generatePage(
  deps: WorkflowDeps,
  ctx: { signal: AbortSignal; onProgress: () => void },
  runId: string,
  input: CreateRunInput,
  storyboard: Storyboard,
  slide: StoryboardSlide,
  pageCount: number,
  failedPages: number[],
): Promise<void> {
  const plan = buildSlidePrompt(slide, storyboard, input);
  const node = await deps.runRepo.createNodeRun(runId, "generate-images");
  await deps.runRepo.startNode(node.id, {
    routeId: deps.imageRoutes[0]?.config.id,
    model: deps.imageRoutes[0]?.model,
  });

  try {
    const startedAt = Date.now();
    let usageAcc: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0 };
    let usedModel: string | null = null;
    let usedRoute: ImageRoute | null = null;

    const result = await withModelFallbacks({
      routes: deps.imageRoutes.map((route) => ({ config: route.config, model: route.model })),
      signal: ctx.signal,
      run: async (fallbackRoute) => {
        const route = deps.imageRoutes.find((r) => r.config.id === fallbackRoute.config.id)!;
        ctx.onProgress();
        const images = await route.image.generate({
          prompt: plan.imagePrompt,
          aspectRatio: input.aspectRatio,
          n: 1,
          signal: ctx.signal,
        });
        usedModel = route.model;
        usedRoute = route;
        usageAcc = mergeUsageInto(usageAcc, images[0]?.usage);
        return images;
      },
      onAttempt: async (record) => {
        await deps.providerRepo.recordAttempt({
          runId,
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

    /* 原生直出图叠加 Brand Kit 水印/签名 */
    let imageToSave: GeneratedImage = image;
    if (hasBrandOverlays(input.brandKit)) {
      imageToSave = await overlayGeneratedImage(image, input.brandKit);
    }

    /* 记录视觉质量审查结果，不自动重试（不静默增加费用） */
    let metadata: Record<string, unknown> = { expectedCopy: plan.expectedCopy };
    if (deps.visualQuality && plan.expectedCopy.length > 0) {
      try {
        const inspection = await deps.visualQuality.inspect({
          imageBase64: image.base64,
          imageUrl: image.remoteUrl,
          instruction: "检查这张中文图文卡片：文字是否清晰可读、是否有错字/缺字/多余文字。",
          expectedText: plan.expectedCopy,
        });
        metadata = {
          ...metadata,
          visualCheck: inspection.checks,
          visualCheckPassed: inspection.passed,
        };
        if (!inspection.passed) {
          logger.warn("native text check flagged issues", { runId, page: slide.index });
        }
      } catch (error) {
        metadata = {
          ...metadata,
          visualCheckError: String(error).slice(0, 200),
        };
        logger.warn("visual inspection failed", { runId, page: slide.index });
      }
    }

    const relPath = path.join("runs", runId, "pages", `page-${slide.index}.png`);
    const saved = await deps.assetStore.saveGeneratedImage(imageToSave, relPath);
    const asset = await deps.assetRepo.create({
      runId,
      nodeRunId: node.id,
      pageIndex: slide.index,
      kind: "generated",
      filePath: saved.filePath,
      mimeType: saved.mimeType,
      bytes: saved.bytes,
      checksum: saved.checksum,
        metadataJson: JSON.stringify({
          ...metadata,
          model: usedModel,
          creditsPerCall: routeCreditsPerCall(usedRoute ?? deps.imageRoutes[0] ?? {}),
        }),
    });

    await deps.runRepo.succeedNode(node.id, {
      outputRef: JSON.stringify({
        pageIndex: slide.index,
        assetId: asset.id,
        role: slide.role,
        headline: slide.headline,
        pageCount,
        visualIntent: slide.visualIntent,
      }),
      images: 1,
      model: usedModel ?? undefined,
      credits: routeCreditsPerCall(usedRoute ?? deps.imageRoutes[0] ?? {}),
      promptTokens: usageAcc.promptTokens,
      completionTokens: usageAcc.completionTokens,
      costUsd: usageAcc.costUsd,
    });
    void startedAt;
  } catch (error) {
    const aiError = toAiError(error);
    await deps.runRepo.failNode(node.id, aiError.category, aiError.message.slice(0, 400), {
      outputRef: JSON.stringify({ pageIndex: slide.index }),
    });
    failedPages.push(slide.index);
    logger.error("page generation failed", {
      runId,
      page: slide.index,
      category: aiError.category,
      error: aiError.message.slice(0, 300),
    });
  }
}

/**
 * 对原生直出图叠加 Brand Kit 水印/签名。
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
  } catch (error) {
    logger.warn("brand overlay skipped", { error: String(error).slice(0, 200) });
    return image;
  }
}

async function writeExportManifest(
  deps: WorkflowDeps,
  runId: string,
  input: CreateRunInput,
  brief: ContentBrief,
  storyboard: Storyboard,
  failedPages: number[],
): Promise<ModelUsage> {
  const exportNode = await deps.runRepo.createNodeRun(runId, "package-export");
  await deps.runRepo.startNode(exportNode.id);
  const totals = await deps.runRepo.runTotals(runId);

  const exportDir = path.join(deps.exportsDir, runId);
  fs.mkdirSync(exportDir, { recursive: true });
  const manifestPath = path.join(exportDir, "manifest.json");

  // 一次取出全部节点与资产（flatMap 回调内无法 await）
  const existingRowsCache = (await deps.runRepo.listNodeRuns(runId)) as unknown as NodeRowLike[];
  const allAssetsCache = await deps.assetRepo.listByRun(runId);

  const pages = storyboard.slides.flatMap((slide) => {
    const pageNode = succeededPageNode(
      existingRowsCache,
      slide.index,
    );
    if (!pageNode) return [];
    const output = JSON.parse(pageNode.outputRef ?? "{}") as { assetId?: string };
    const asset = output.assetId
      ? allAssetsCache.find((row) => row.id === output.assetId)
      : undefined;
    if (!asset) return [];
    const metadata = JSON.parse(asset.metadataJson ?? "{}") as Record<string, unknown>;
    return [
      {
        pageIndex: slide.index,
        role: slide.role,
        headline: slide.headline,
        assetId: asset.id,
        filePath: asset.filePath,
        expectedCopy: metadata.expectedCopy,
        visualCheckPassed: metadata.visualCheckPassed,
      },
    ];
  });

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        runId,
        input,
        brief,
        storyboard: {
          title: storyboard.title,
          platform: storyboard.platform,
          aspectRatio: storyboard.aspectRatio,
        },
        pages,
        failedPages,
        usage: totals,
        generatedAt: toBeijingIsoString(),
      },
      null,
      2,
    ),
  );

  const manifestAsset = await deps.assetRepo.create({
    runId,
    nodeRunId: exportNode.id,
    kind: "export-manifest",
    filePath: manifestPath,
    mimeType: "application/json",
    bytes: fs.statSync(manifestPath).size,
  });
  await deps.runRepo.succeedNode(exportNode.id, {
    outputRef: JSON.stringify({ manifestAssetId: manifestAsset.id }),
  });
  return totals;
}

/** 执行结构化生成节点；已成功则直接复用输出（幂等） */
async function runStructuredNode<T>(
  deps: WorkflowDeps,
  ctx: { signal: AbortSignal; onProgress: () => void },
  runId: string,
  existingNodes: NodeRowLike[],
  spec: {
    nodeName: string;
    schemaName: string;
    schema: z.ZodType<T>;
    buildPrompt: () => string;
  },
): Promise<{ value: T; nodeId: string }> {
  const succeeded = succeededNode(existingNodes, spec.nodeName);
  if (succeeded?.outputRef) {
    try {
      return { value: (JSON.parse(succeeded.outputRef) as { value: T }).value, nodeId: succeeded.id };
    } catch {
      /* 输出损坏则重新生成 */
    }
  }

  const node = await deps.runRepo.createNodeRun(runId, spec.nodeName);
  await deps.runRepo.startNode(node.id, {
    routeId: deps.textRoutes[0]?.config.id,
    model: deps.textRoutes[0]?.model,
  });

  try {
    let usageAcc: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0 };
    let usedRoute: TextRoute | null = null;
    const value = await withModelFallbacks({
      routes: deps.textRoutes.map((route) => ({ config: route.config, model: route.model })),
      signal: ctx.signal,
      run: async (fallbackRoute) => {
        const route = deps.textRoutes.find((r) => r.config.id === fallbackRoute.config.id)!;
        ctx.onProgress();
        const credits = routeCreditsPerCall(route);
        let reserved = false;
        try {
          if (deps.reserveModelCredits && credits > 0) {
            await deps.reserveModelCredits(runId, credits);
            reserved = true;
          }
          const result = await route.text.generateObject({
            prompt: spec.buildPrompt(),
            schemaName: spec.schemaName,
            schema: spec.schema,
            signal: ctx.signal,
            onUsage: (usage) => {
              usageAcc = mergeUsageInto(usageAcc, usage);
            },
          });
          usedRoute = route;
          if (reserved) {
            await deps.captureModelCredits?.(runId, node.id, credits, route.model);
            reserved = false;
          }
          return result;
        } catch (error) {
          if (reserved) {
            if (deps.releaseModelCredits) {
              await deps.releaseModelCredits(runId, credits).catch((releaseError) =>
                logger.error("release text model credits failed", { runId, nodeRunId: node.id, error: String(releaseError) }),
              );
            }
          }
          throw error;
        }
      },
      onAttempt: async (record) => {
        await deps.providerRepo.recordAttempt({
          runId,
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

    const actualTextRoute = usedRoute as TextRoute | null;
    await deps.providerRepo.recordUsage({
      runId,
      nodeRunId: node.id,
      routeId: actualTextRoute?.config.id ?? deps.textRoutes[0]?.config.id ?? "unknown",
      model: actualTextRoute?.model ?? deps.textRoutes[0]?.model,
      promptTokens: usageAcc.promptTokens,
      completionTokens: usageAcc.completionTokens,
      totalTokens: usageAcc.totalTokens,
    });
    await deps.runRepo.succeedNode(node.id, {
      outputRef: JSON.stringify({ value, schemaName: spec.schemaName }),
      promptTokens: usageAcc.promptTokens,
      completionTokens: usageAcc.completionTokens,
      costUsd: usageAcc.costUsd,
    });
    return { value, nodeId: node.id };
  } catch (error) {
    const aiError = toAiError(error);
    await deps.runRepo.failNode(node.id, aiError.category, aiError.message.slice(0, 400));
    throw error;
  }
}

/** 用户取消：Run 置为 cancelled 并抛出，Runner 会保留取消终态 */
async function throwIfAborted(
  deps: WorkflowDeps,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    await deps.runRepo.updateStatus(runId, "cancelled");
    throw new Error("run cancelled by user");
  }
}

function mergeUsageInto(acc: ModelUsage, incoming: ModelUsage | undefined): ModelUsage {
  if (!incoming) return acc;  return {
    promptTokens: acc.promptTokens + incoming.promptTokens,
    completionTokens: acc.completionTokens + incoming.completionTokens,
    totalTokens: acc.totalTokens + incoming.totalTokens,
    images: acc.images + incoming.images,
    costUsd:
      acc.costUsd === undefined && incoming.costUsd === undefined
        ? undefined
        : (acc.costUsd ?? 0) + (incoming.costUsd ?? 0),
  };
}
