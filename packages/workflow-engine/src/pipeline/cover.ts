import fs from "node:fs";
import path from "node:path";
import { toAiError, withModelFallbacks, type Semaphore } from "@aai/ai-core";
import {
  CoverPlanSchema,
  type CoverCandidatePlan,
  type CoverPlan,
  type CreateRunInput,
  type GeneratedImage,
  type ModelUsage,
  type Storyboard,
} from "@aai/shared-schemas";
import type { AssetRepo, JobRepo, ProviderRepo, RunRepo, AssetStore } from "@aai/storage";
import { applyBrandOverlays, hasBrandOverlays, renderSlideDeterministic, themeById } from "@aai/render-engine";
import { buildCoverPlanPrompt, buildStyleHint } from "../prompts";
import { logger } from "../logger";
import type { JobRunner } from "../job-runner";
import type { ImageRoute, TextRoute } from "./knowledge-cards";

/**
 * 封面工序（增强能力）：
 * - 每个作品产出 3 个封面候选（不同标题钩子/构图），用户挑选一个作为作品封面；
 * - 封面失败绝不影响主流程：knowledge-cards 管线内吞掉全部错误；
 * - Comic 管线不做封面（漫画首页即封面，无需额外候选）。
 */

export const COVER_JOB_KIND = "cover_generate";
export const COVER_NODE_NAME = "generate-covers";

/** 封面工序依赖（WorkflowDeps 的子集；visualQuality 不需要） */
export interface CoverDeps {
  runRepo: RunRepo;
  jobRepo: JobRepo;
  assetRepo: AssetRepo;
  providerRepo: ProviderRepo;
  assetStore: AssetStore;
  textRoutes: TextRoute[];
  imageRoutes: ImageRoute[];
  imageApiSemaphore: Semaphore;
  assetsDir: string;
}

interface CoverStageCtx {
  signal: AbortSignal;
  onProgress: () => void;
}

interface NodeRowLike {
  id: string;
  nodeName: string;
  status: string;
  outputRef: string | null;
}

function succeededCoverNode(rows: NodeRowLike[]): NodeRowLike | undefined {
  return rows.find((row) => row.nodeName === COVER_NODE_NAME && row.status === "succeeded");
}

/** 从 generate-brief 节点读取核心结论（封面 Prompt 的语境；缺失时返回 undefined） */
async function loadCoreMessage(deps: CoverDeps, runId: string): Promise<string | undefined> {
  try {
    const nodes = (await deps.runRepo.listNodeRuns(runId)) as unknown as NodeRowLike[];
    const briefNode = nodes.find((n) => n.nodeName === "generate-brief" && n.status === "succeeded");
    if (!briefNode?.outputRef) return undefined;
    return (JSON.parse(briefNode.outputRef) as { value?: { coreMessage?: string } }).value?.coreMessage;
  } catch {
    return undefined;
  }
}

/** 从 generate-storyboard 节点加载 Storyboard（手动补生成入口用） */
async function loadStoryboard(deps: CoverDeps, runId: string): Promise<Storyboard> {
  const nodes = (await deps.runRepo.listNodeRuns(runId)) as unknown as NodeRowLike[];
  const node = nodes.find((n) => n.nodeName === "generate-storyboard" && n.status === "succeeded");
  if (!node?.outputRef) throw new Error("storyboard not found for run");
  return (JSON.parse(node.outputRef) as { value: Storyboard }).value;
}

/** 文本结构化生成（带渠道路由回退），与 knowledge-cards runStructuredNode 同模式 */
async function generateCoverPlan(
  deps: CoverDeps,
  ctx: CoverStageCtx,
  runId: string,
  nodeRunId: string,
  input: CreateRunInput,
  storyboard: Storyboard,
  coreMessage: string | undefined,
): Promise<CoverPlan> {
  let usageAcc: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0 };
  const value = await withModelFallbacks({
    routes: deps.textRoutes.map((route) => ({ config: route.config, model: route.model })),
    signal: ctx.signal,
    run: async (fallbackRoute) => {
      const route = deps.textRoutes.find((r) => r.config.id === fallbackRoute.config.id)!;
      ctx.onProgress();
      return route.text.generateObject({
        prompt: buildCoverPlanPrompt(input, storyboard, coreMessage),
        schemaName: "CoverPlan",
        schema: CoverPlanSchema,
        signal: ctx.signal,
        onUsage: (usage) => {
          usageAcc = usage;
        },
      });
    },
    onAttempt: async (record) => {
      await deps.providerRepo.recordAttempt({
        runId,
        nodeRunId,
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
  await deps.providerRepo.recordUsage({
    runId,
    nodeRunId,
    routeId: deps.textRoutes[0]?.config.id ?? "unknown",
    model: deps.textRoutes[0]?.model,
    promptTokens: usageAcc.promptTokens,
    completionTokens: usageAcc.completionTokens,
    totalTokens: usageAcc.totalTokens,
  });
  return value as CoverPlan;
}

/** 单个候选的图片 Prompt 与生成参数 */
function buildCoverImagePrompt(
  input: CreateRunInput,
  candidate: CoverCandidatePlan,
  mode: "native" | "deterministic",
): string {
  const styleLines = buildStyleHint(input);
  if (mode === "native") {
    return [
      `主题：${input.topic}`,
      `封面主视觉：${candidate.visualPrompt}。`,
      `封面大字标题（必须逐字出现在画面上，粗体、居中、不超过 12 字）：${candidate.hookTitle}`,
      `画布比例：${input.aspectRatio}`,
      `目标平台：${input.platform}`,
      ...styleLines,
      "要求：图中中文必须清晰可读、无错字、无缺字；除封面大字标题外，画面中不得出现任何其他文字、数字、水印或 Logo。",
    ].join("\n");
  }
  return [
    `主题：${input.topic}`,
    `画布比例：${input.aspectRatio}`,
    `画面：${candidate.visualPrompt}。版式：封面主视觉，主体突出、构图简洁。`,
    ...styleLines,
    "要求：只生成无文字的视觉层（背景、插画、装饰）；画面中绝对不要出现任何文字、数字、字母、水印或 Logo；四周各预留 8% 安全边距供后续排版。",
  ].join("\n");
}

/** 读取 Brand Kit Logo（缺失或读取失败时返回 undefined，不阻塞渲染） */
async function readLogoBase64(deps: CoverDeps, input: CreateRunInput): Promise<string | undefined> {
  const logoAssetId = input.brandKit?.logoAssetId;
  if (!logoAssetId) return undefined;
  try {
    const asset = await deps.assetRepo.require(logoAssetId);
    return fs.readFileSync(deps.assetStore.resolve(asset.filePath)).toString("base64");
  } catch {
    return undefined;
  }
}

/** 对原生直出图叠加 Brand Kit 水印/签名（与 page-regen 同规则；仅 base64 直出可叠加） */
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

export interface CoverStageResult {
  /** 已有成功的 generate-covers 节点，本次整体跳过 */
  skipped: boolean;
  /** 成功落库的候选数 */
  produced: number;
  /** 生成失败的候选序号（1-based） */
  failedVariants: number[];
}

/**
 * 封面候选生成共享执行函数（knowledge-cards 管线与 cover_generate 手动补生成入口共用）：
 * 1. 文本模型取 CoverPlan（恰好 3 个候选，不同标题公式）；
 * 2. 逐个生成封面图并落资产（kind="cover"、pageIndex=-1）；
 * 3. 单个候选图片失败不阻塞其余候选；计划生成失败则节点失败并抛出（由调用方决定是否吞掉）。
 * 幂等：已有 succeeded 的 generate-covers 节点时整体跳过。
 */
export async function generateCoverCandidates(
  deps: CoverDeps,
  args: {
    runId: string;
    input: CreateRunInput;
    storyboard: Storyboard;
    ctx: CoverStageCtx;
    /** Brief 核心结论（可选语境；缺省时内部自动从节点读取） */
    coreMessage?: string | undefined;
  },
): Promise<CoverStageResult> {
  const { runId, input, storyboard, ctx } = args;
  const existingNodes = (await deps.runRepo.listNodeRuns(runId)) as unknown as NodeRowLike[];
  if (succeededCoverNode(existingNodes)) {
    return { skipped: true, produced: 0, failedVariants: [] };
  }

  const mode = input.textRenderingMode === "deterministic" ? "deterministic" : "native";
  const node = await deps.runRepo.createNodeRun(runId, COVER_NODE_NAME);
  await deps.runRepo.startNode(node.id, {
    routeId: deps.imageRoutes[0]?.config.id,
    model: deps.imageRoutes[0]?.model,
  });

  try {
    const coreMessage = args.coreMessage ?? (await loadCoreMessage(deps, runId));
    const plan = await generateCoverPlan(deps, ctx, runId, node.id, input, storyboard, coreMessage);

    const pageCount = storyboard.slides.length;
    const logoBase64 = await readLogoBase64(deps, input);
    const failedVariants: number[] = [];
    let produced = 0;

    for (let i = 0; i < plan.candidates.length; i++) {
      const candidate = plan.candidates[i]!;
      const variant = i + 1;
      try {
        const imagePrompt = buildCoverImagePrompt(input, candidate, mode);
        const result = await withModelFallbacks({
          routes: deps.imageRoutes.map((route) => ({ config: route.config, model: route.model })),
          signal: ctx.signal,
          run: async (fallbackRoute) => {
            const route = deps.imageRoutes.find((r) => r.config.id === fallbackRoute.config.id)!;
            return deps.imageApiSemaphore.run(async () => {
              ctx.onProgress();
              return route.image.generate({
                prompt: imagePrompt,
                aspectRatio: input.aspectRatio,
                n: 1,
                signal: ctx.signal,
              });
            });
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

        // deterministic：AI 只出视觉层，文字（hookTitle + styleNote）由程序排版合成；
        // native：模型直出成品封面（含大字标题），叠加 Brand Kit 水印后直接落库
        let saved: { filePath: string; bytes: number };
        if (mode === "deterministic") {
          let visualBase64 = image.base64 ?? null;
          if (!visualBase64) {
            // URL 直出无 base64：先落盘再读（与 page-regen 同模式）
            const visualRel = path.join("runs", runId, "covers", `cover-${variant}-visual.png`);
            const visualSaved = await deps.assetStore.saveGeneratedImage(image, visualRel);
            visualBase64 = fs.readFileSync(visualSaved.filePath).toString("base64");
          }
          const buffer = await renderSlideDeterministic({
            theme: themeById(input.brandKit?.themeId),
            aspectRatio: input.aspectRatio,
            slide: {
              index: 0,
              role: "cover",
              headline: candidate.hookTitle,
              body: [candidate.styleNote],
              visualIntent: candidate.visualPrompt,
              layoutHint: "封面候选",
            },
            pageCount,
            visualImageBase64: visualBase64,
            logoBase64,
            brand: input.brandKit,
          });
          saved = await deps.assetStore.saveBuffer(
            buffer,
            path.join("runs", runId, "covers", `cover-${variant}.png`),
          );
        } else {
          const imageToSave = hasBrandOverlays(input.brandKit)
            ? await overlayGeneratedImage(image, input.brandKit)
            : image;
          saved = await deps.assetStore.saveGeneratedImage(
            imageToSave,
            path.join("runs", runId, "covers", `cover-${variant}.png`),
          );
        }

        await deps.assetRepo.create({
          runId,
          nodeRunId: node.id,
          pageIndex: -1,
          kind: "cover",
          filePath: saved.filePath,
          mimeType: "image/png",
          bytes: saved.bytes,
          metadataJson: JSON.stringify({
            purpose: "cover",
            variant,
            hookTitle: candidate.hookTitle,
            styleNote: candidate.styleNote,
            mode,
          }),
        });
        produced += 1;
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const aiError = toAiError(error);
        failedVariants.push(variant);
        logger.warn("cover candidate failed", {
          runId,
          variant,
          category: aiError.category,
          error: aiError.message.slice(0, 300),
        });
      }
    }

    await deps.runRepo.succeedNode(node.id, {
      outputRef: JSON.stringify({ produced, failedVariants, variants: plan.candidates.length }),
      images: produced,
    });
    logger.info("cover candidates generated", { runId, produced, failedVariants, mode });
    return { skipped: false, produced, failedVariants };
  } catch (error) {
    const aiError = toAiError(error);
    await deps.runRepo.failNode(node.id, aiError.category, aiError.message.slice(0, 400));
    throw error;
  }
}

/**
 * knowledge-cards 管线内嵌封面工序：generate-covers 节点。
 * 内部全 catch——封面任何失败都不影响 run 成功（仅用户取消时向上抛以保证取消语义）。
 */
export async function runCoverStage(
  deps: CoverDeps,
  ctx: CoverStageCtx,
  runId: string,
  input: CreateRunInput,
  storyboard: Storyboard,
): Promise<void> {
  try {
    await generateCoverCandidates(deps, { runId, input, storyboard, ctx });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    logger.warn("cover stage failed (non-blocking)", { runId, error: String(error).slice(0, 300) });
  }
}

/**
 * 注册手动补生成入口的作业（POST /api/runs/:id/covers/generate）：
 * 加载 run/input/storyboard 后复用共享执行函数；失败时作业置 failed（不影响 run 状态）。
 */
export function registerCoverPipeline(runner: JobRunner, deps: CoverDeps): void {
  runner.register(COVER_JOB_KIND, async (ctx) => {
    if (!ctx.runId) throw new Error("cover_generate requires runId");
    const run = await deps.runRepo.require(ctx.runId);
    const input = JSON.parse(run.inputJson) as CreateRunInput;
    const storyboard = await loadStoryboard(deps, ctx.runId);
    await generateCoverCandidates(deps, {
      runId: ctx.runId,
      input,
      storyboard,
      ctx: { signal: ctx.signal, onProgress: ctx.onProgress },
    });
  });
}
