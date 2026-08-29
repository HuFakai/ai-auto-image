import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  ContentBriefSchema,
  StoryboardSchema,
  effectiveImageConcurrency,
  type ContentBrief,
  type CreateRunInput,
  type ModelUsage,
  type ProviderRouteConfig,
  type Storyboard,
  type StoryboardSlide,
} from "@aai/shared-schemas";
import {
  toAiError,
  withModelFallbacks,
  type ImageModel,
  type Semaphore,
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
import { renderSlideDeterministic, themeById } from "@aai/render-engine";
import { logger } from "../logger";
import type { JobRunner } from "../job-runner";
import { buildBriefPrompt, buildSlidePrompt, buildStoryboardPrompt } from "../prompts";

export const KNOWLEDGE_CARD_KIND = "knowledge_card_run";

/** 已绑定文本模型的路由 */
export interface TextRoute {
  config: ProviderRouteConfig;
  model: string;
  text: TextModel;
}

/** 已绑定图片模型的路由 */
export interface ImageRoute {
  config: ProviderRouteConfig;
  model: string;
  image: ImageModel;
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
  imageApiSemaphore: Semaphore;
  serverMaxConcurrency: number;
  postprocessMax: number;
  assetsDir: string;
  exportsDir: string;
  /** 确定性渲染模板版本（冻结进 RunSnapshot） */
  templateVersion: string;
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
 * 阶段 0 Spike 流水线（docs/phases/00 §7）：
 * parse-input → generate-brief → generate-storyboard → generate-images（按有效并发并行）
 * → render-slides（仅确定性模式）→ package-export。
 *
 * 所有节点幂等：Job 重试或应用重启恢复时，已成功的节点与页面直接跳过，
 * 因此"单页失败仅重试该页"与"重启恢复不重跑已完成页面"天然成立。
 */
export function registerKnowledgeCardPipeline(runner: JobRunner, deps: WorkflowDeps): void {
  runner.register(KNOWLEDGE_CARD_KIND, async (ctx) => {
    if (!ctx.runId) throw new Error("knowledge_card_run requires runId");
    const run = deps.runRepo.require(ctx.runId);
    const input = JSON.parse(run.inputJson) as CreateRunInput;
    deps.runRepo.updateStatus(run.id, "running");

    try {
      await executeKnowledgeCardRun(deps, ctx, run.id, input);
    } catch (error) {
      // 中途取消发生在节点内部时，保证 Run 不停留在 running
      if (ctx.signal.aborted) {
        deps.runRepo.updateStatus(run.id, "cancelled");
      }
      throw error;
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
  const existingNodes = deps.runRepo.listNodeRuns(runId) as unknown as NodeRowLike[];
    const providerMaxValues = deps.imageRoutes
      .map((route) => route.config.imageConcurrencyMax)
      .filter((value): value is number => typeof value === "number");
    const effective = effectiveImageConcurrency({
      requested: input.requestedImageConcurrency,
      serverMax: deps.serverMaxConcurrency,
      providerMax: providerMaxValues.length > 0 ? Math.min(...providerMaxValues) : undefined,
    });

    /* parse-input */
    if (!succeededNode(existingNodes, "parse-input")) {
      const node = deps.runRepo.createNodeRun(runId, "parse-input");
      deps.runRepo.startNode(node.id);
      deps.runRepo.succeedNode(node.id, {
        outputRef: JSON.stringify({
          platform: input.platform,
          aspectRatio: input.aspectRatio,
          mode: input.textRenderingMode,
        }),
      });
    }

    /* RunSnapshot：冻结模式、并发、路由与模板版本 */
    deps.runRepo.setSnapshot(
      runId,
      JSON.stringify({
        textRenderingMode: input.textRenderingMode,
        concurrency: {
          requested: input.requestedImageConcurrency,
          serverMax: deps.serverMaxConcurrency,
          effective,
          postprocessMax: deps.postprocessMax,
        },
        routes: [...deps.textRoutes, ...deps.imageRoutes].map((route) => ({
          id: route.config.id,
          kind: route.config.kind,
          model: route.model,
        })),
        templateVersion: deps.templateVersion,
      }),
    );

    /* generate-brief */
    const brief = await runStructuredNode(deps, ctx, runId, existingNodes, {
      nodeName: "generate-brief",
      schemaName: "ContentBrief",
      schema: ContentBriefSchema,
      buildPrompt: () => buildBriefPrompt(input),
    });
    throwIfAborted(deps, runId, ctx.signal);

    /* generate-storyboard */
    const storyboard = await runStructuredNode(deps, ctx, runId, existingNodes, {
      nodeName: "generate-storyboard",
      schemaName: "Storyboard",
      schema: StoryboardSchema,
      buildPrompt: () => buildStoryboardPrompt(input, brief),
    });
    // LLM 可能输出 1-based 页码；统一归一化为 0-based，保证文件名、页码标签与顺序一致
    storyboard.slides.forEach((slide, index) => {
      slide.index = index;
    });
    throwIfAborted(deps, runId, ctx.signal);
    const pageCount = storyboard.slides.length;

    /* generate-images：按有效并发并行；已成功页面跳过 */
    const failedPages: number[] = [];
    const pageTasks = storyboard.slides.map((slide) => async () => {
      if (succeededPageNode(deps.runRepo.listNodeRuns(runId) as unknown as NodeRowLike[], slide.index)) {
        return;
      }
      await generatePage(deps, ctx, runId, input, storyboard, slide, pageCount, effective, failedPages);
    });
    await runPool(pageTasks, effective);
    throwIfAborted(deps, runId, ctx.signal);

    /* render-slides：仅确定性模式 */
    if (input.textRenderingMode === "deterministic") {
      await renderAllSlides(deps, runId, input, storyboard, pageCount);
    }

    /* package-export */
    const totals = writeExportManifest(deps, runId, input, brief, storyboard, failedPages);

    if (failedPages.length > 0) {
      const summary = `pages failed: ${failedPages.join(", ")}`;
      deps.runRepo.updateStatus(runId, "failed", { errorSummary: summary });
      throw new Error(summary);
    }
    deps.runRepo.updateStatus(runId, "succeeded");
    logger.info("knowledge card run completed", {
      runId: runId,
      pages: pageCount,
      mode: input.textRenderingMode,
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
  effective: number,
  failedPages: number[],
): Promise<void> {
  const mode = input.textRenderingMode;
  const plan = buildSlidePrompt(slide, storyboard, input, mode);
  const node = deps.runRepo.createNodeRun(runId, "generate-images");
  deps.runRepo.startNode(node.id, {
    routeId: deps.imageRoutes[0]?.config.id,
    model: deps.imageRoutes[0]?.model,
  });

  try {
    const startedAt = Date.now();
    let usageAcc: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0 };

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
          usageAcc = mergeUsageInto(usageAcc, images[0]?.usage);
          return images;
        });
      },
      onAttempt: (record) => {
        deps.providerRepo.recordAttempt({
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

    /* 原生模式文字审查：记录结果，不自动重试（不静默增加费用） */
    let metadata: Record<string, unknown> = { mode, expectedCopy: plan.expectedCopy };
    if (mode === "native" && deps.visualQuality && plan.expectedCopy.length > 0) {
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
    const saved = await deps.assetStore.saveGeneratedImage(image, relPath);
    const asset = deps.assetRepo.create({
      runId,
      nodeRunId: node.id,
      pageIndex: slide.index,
      kind: "generated",
      filePath: saved.filePath,
      mimeType: saved.mimeType,
      bytes: saved.bytes,
      checksum: saved.checksum,
      metadataJson: JSON.stringify(metadata),
    });

    deps.runRepo.succeedNode(node.id, {
      outputRef: JSON.stringify({
        pageIndex: slide.index,
        assetId: asset.id,
        role: slide.role,
        headline: slide.headline,
        pageCount,
        visualIntent: slide.visualIntent,
      }),
      images: 1,
      promptTokens: usageAcc.promptTokens,
      completionTokens: usageAcc.completionTokens,
      costUsd: usageAcc.costUsd,
    });
    void startedAt;
    void effective;
  } catch (error) {
    const aiError = toAiError(error);
    deps.runRepo.failNode(node.id, aiError.category, aiError.message.slice(0, 400));
    failedPages.push(slide.index);
    logger.error("page generation failed", {
      runId,
      page: slide.index,
      category: aiError.category,
      error: aiError.message.slice(0, 300),
    });
  }
}

/** 读取 Brand Kit Logo（缺失或读取失败时返回 undefined，不阻塞渲染） */
function readLogoBase64(deps: WorkflowDeps, input: CreateRunInput): string | undefined {
  const logoAssetId = input.brandKit?.logoAssetId;
  if (!logoAssetId) return undefined;
  try {
    const asset = deps.assetRepo.require(logoAssetId);
    return fs.readFileSync(deps.assetStore.resolve(asset.filePath)).toString("base64");
  } catch {
    return undefined;
  }
}

async function renderAllSlides(
  deps: WorkflowDeps,
  runId: string,
  input: CreateRunInput,
  storyboard: Storyboard,
  pageCount: number,
): Promise<void> {
  const renderNode = deps.runRepo.createNodeRun(runId, "render-slides");
  deps.runRepo.startNode(renderNode.id, { model: deps.templateVersion });
  try {
    for (const slide of storyboard.slides) {
      const pageNode = succeededPageNode(
        deps.runRepo.listNodeRuns(runId) as unknown as NodeRowLike[],
        slide.index,
      );
      if (!pageNode) continue;

      const visualAsset = deps.assetRepo.require(
        (JSON.parse(pageNode.outputRef ?? "{}") as { assetId?: string }).assetId!,
      );
      const visualBase64 = fs.readFileSync(deps.assetStore.resolve(visualAsset.filePath)).toString("base64");
      const logoBase64 = readLogoBase64(deps, input);

      const buffer = await renderSlideDeterministic({
        theme: themeById(input.brandKit?.themeId),
        aspectRatio: input.aspectRatio,
        slide,
        pageCount,
        visualImageBase64: visualBase64,
        logoBase64,
      });
      const saved = await deps.assetStore.saveBuffer(
        buffer,
        path.join("runs", runId, "pages", `page-${slide.index}-composite.png`),
      );
      deps.assetRepo.create({
        runId,
        nodeRunId: renderNode.id,
        pageIndex: slide.index,
        kind: "composite",
        filePath: saved.filePath,
        mimeType: saved.mimeType,
        bytes: saved.bytes,
        checksum: saved.checksum,
        metadataJson: JSON.stringify({
          mode: "deterministic",
          expectedCopy: [slide.headline, ...slide.body],
          templateVersion: deps.templateVersion,
        }),
      });
    }
    deps.runRepo.succeedNode(renderNode.id, {
      outputRef: JSON.stringify({ templateVersion: deps.templateVersion }),
    });
  } catch (error) {
    const aiError = toAiError(error);
    deps.runRepo.failNode(renderNode.id, aiError.category, aiError.message.slice(0, 400));
    throw error;
  }
}

function writeExportManifest(
  deps: WorkflowDeps,
  runId: string,
  input: CreateRunInput,
  brief: ContentBrief,
  storyboard: Storyboard,
  failedPages: number[],
): ModelUsage {
  const exportNode = deps.runRepo.createNodeRun(runId, "package-export");
  deps.runRepo.startNode(exportNode.id);
  const totals = deps.runRepo.runTotals(runId);

  const exportDir = path.join(deps.exportsDir, runId);
  fs.mkdirSync(exportDir, { recursive: true });
  const manifestPath = path.join(exportDir, "manifest.json");

  const pages = storyboard.slides.flatMap((slide) => {
    const pageNode = succeededPageNode(
      deps.runRepo.listNodeRuns(runId) as unknown as NodeRowLike[],
      slide.index,
    );
    if (!pageNode) return [];
    const output = JSON.parse(pageNode.outputRef ?? "{}") as { assetId?: string };
    const asset = deps.assetRepo.listByRun(runId).find((row) => row.id === output.assetId);
    if (!asset) return [];
    const metadata = JSON.parse(asset.metadataJson ?? "{}") as Record<string, unknown>;
    return [
      {
        pageIndex: slide.index,
        role: slide.role,
        headline: slide.headline,
        assetId: asset.id,
        filePath: asset.filePath,
        mode: metadata.mode,
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
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const manifestAsset = deps.assetRepo.create({
    runId,
    nodeRunId: exportNode.id,
    kind: "export-manifest",
    filePath: manifestPath,
    mimeType: "application/json",
    bytes: fs.statSync(manifestPath).size,
  });
  deps.runRepo.succeedNode(exportNode.id, {
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
): Promise<T> {
  const succeeded = succeededNode(existingNodes, spec.nodeName);
  if (succeeded?.outputRef) {
    try {
      return (JSON.parse(succeeded.outputRef) as { value: T }).value;
    } catch {
      /* 输出损坏则重新生成 */
    }
  }

  const node = deps.runRepo.createNodeRun(runId, spec.nodeName);
  deps.runRepo.startNode(node.id, {
    routeId: deps.textRoutes[0]?.config.id,
    model: deps.textRoutes[0]?.model,
  });

  try {
    let usageAcc: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0 };
    const value = await withModelFallbacks({
      routes: deps.textRoutes.map((route) => ({ config: route.config, model: route.model })),
      signal: ctx.signal,
      run: async (fallbackRoute) => {
        const route = deps.textRoutes.find((r) => r.config.id === fallbackRoute.config.id)!;
        ctx.onProgress();
        const result = await route.text.generateObject({
          prompt: spec.buildPrompt(),
          schemaName: spec.schemaName,
          schema: spec.schema,
          signal: ctx.signal,
          onUsage: (usage) => {
            usageAcc = mergeUsageInto(usageAcc, usage);
          },
        });
        return result;
      },
      onAttempt: (record) => {
        deps.providerRepo.recordAttempt({
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

    deps.providerRepo.recordUsage({
      runId,
      nodeRunId: node.id,
      routeId: deps.textRoutes[0]?.config.id ?? "unknown",
      model: deps.textRoutes[0]?.model,
      promptTokens: usageAcc.promptTokens,
      completionTokens: usageAcc.completionTokens,
      totalTokens: usageAcc.totalTokens,
    });
    deps.runRepo.succeedNode(node.id, {
      outputRef: JSON.stringify({ value, schemaName: spec.schemaName }),
      promptTokens: usageAcc.promptTokens,
      completionTokens: usageAcc.completionTokens,
      costUsd: usageAcc.costUsd,
    });
    return value;
  } catch (error) {
    const aiError = toAiError(error);
    deps.runRepo.failNode(node.id, aiError.category, aiError.message.slice(0, 400));
    throw error;
  }
}

/** 用户取消：Run 置为 cancelled 并抛出，Runner 会保留取消终态 */
function throwIfAborted(
  deps: WorkflowDeps,
  runId: string,
  signal: AbortSignal,
): void {
  if (signal.aborted) {
    deps.runRepo.updateStatus(runId, "cancelled");
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

async function runPool(tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, tasks.length)) },
    async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        if (!task) return;
        await task();
      }
    },
  );
  await Promise.all(workers);
}
