import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CharacterAnchorSchema,
  ComicStoryboardSchema,
  toBeijingIsoString,
  type CharacterAnchor,
  type ComicStoryboard,
  type CreateRunInput,
  type GeneratedImage,
  type ModelUsage,
} from "@aai/shared-schemas";
import {
  toAiError,
  withModelFallbacks,
  type VisualQualityModel,
} from "@aai/ai-core";
import type { AssetRepo, JobRepo, ProviderRepo, RevisionRepo, RunRepo, AssetStore } from "@aai/storage";
import type { ImageRoute, TextRoute } from "./knowledge-cards";
import { applyBrandOverlays, hasBrandOverlays } from "@aai/render-engine";
import { logger } from "../logger";
import type { JobRunner } from "../job-runner";
import { buildComicStoryboardPrompt, buildStyleHint } from "../prompts";
import { releaseReservedCredits, reserveCreditsToTarget } from "./credit-reservation";
import { maxRouteCredits, routeCreditsPerCall, selectWorkflowRoutes } from "../route-selection";

export const COMIC_RUN_KIND = "comic_story_run";

interface ComicJobPayload {
  mode?: "checkpoint" | "restart" | "page";
  sourceRunId?: string;
  targetPageIndex?: number;
}

export interface ComicPipelineDeps {
  runRepo: RunRepo;
  jobRepo: JobRepo;
  assetRepo: AssetRepo;
  providerRepo: ProviderRepo;
  revisionRepo: RevisionRepo;
  assetStore: AssetStore;
  textRoutes: TextRoute[];
  imageRoutes: ImageRoute[];
  visualQuality: VisualQualityModel | null;
  assetsDir: string;
  exportsDir: string;
  /** 可选计费回调：图片 Provider 调用前预留额度 */
  reserveImageCredits?: (runId: string, amount: number) => Promise<void>;
  /** 可选计费回调：运行结束、失败或取消时释放未结算额度 */
  releaseImageCredits?: (runId: string) => Promise<void>;
  reserveModelCredits?: (runId: string, amount: number) => Promise<void>;
  captureModelCredits?: (runId: string, nodeRunId: string, amount: number, model?: string) => Promise<void>;
  releaseModelCredits?: (runId: string, amount: number) => Promise<void>;
}

/** 一致性规则检查项（与 QualityCheck 形状一致） */
function check(name: string, status: "pass" | "warn" | "fail", detail: string) {
  return { name, status, detail };
}

/** 一致性规则检查：对白归属、页数、出场角色必须在角色锚点中 */
export function runComicConsistencyChecks(
  storyboard: ComicStoryboard,
  expectedPages: [number, number] = [3, 6],
): Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> {
  const checks = [];
  const castNames = new Set(storyboard.cast.map((member) => member.name));
  checks.push(
    storyboard.pages.length >= expectedPages[0] && storyboard.pages.length <= expectedPages[1]
      ? check("comic_page_count", "pass", `${storyboard.pages.length} 页在 ${expectedPages[0]}–${expectedPages[1]} 范围内`)
      : check("comic_page_count", "fail", `${storyboard.pages.length} 页超出 ${expectedPages[0]}–${expectedPages[1]} 范围`),
  );
  const unknownSpeakers = new Set<string>();
  const unknownCastRefs = new Set<string>();
  for (const page of storyboard.pages) {
    for (const dialogue of page.dialogues) {
      // 旁白的 speaker 是栏目标签而非角色，不参与归属校验
      if (dialogue.type !== "narration" && !castNames.has(dialogue.speaker)) {
        unknownSpeakers.add(dialogue.speaker);
      }
    }
    for (const name of page.cast) {
      if (!castNames.has(name)) unknownCastRefs.add(name);
    }
  }
  checks.push(
    unknownSpeakers.size === 0
      ? check("dialogue_attribution", "pass", "所有对白归属均在角色锚点中")
      : check("dialogue_attribution", "fail", `未知对白角色：${[...unknownSpeakers].join("、")}`),
  );
  checks.push(
    unknownCastRefs.size === 0
      ? check("cast_reference", "pass", "页面出场角色均在角色锚点中")
      : check("cast_reference", "warn", `未登记的出场角色：${[...unknownCastRefs].join("、")}`),
  );
  const missingDialogue = storyboard.pages.filter((page) => page.dialogues.length === 0).length;
  checks.push(
    missingDialogue === 0
      ? check("dialogue_coverage", "pass", "每页都有对白或旁白")
      : check("dialogue_coverage", "warn", `${missingDialogue} 页无对白（允许，但检查画面是否表达了内容）`),
  );
  return checks;
}

/** 角色锚点 → 逐页注入的身份锚定文本（跨页一致性的核心） */
export function buildCharacterAnchorText(cast: CharacterAnchor[]): string {
  return cast
    .map(
      (member) =>
        `【${member.name}】外貌：${member.appearance}；服装：${member.outfit}；` +
        `禁止变化：${member.forbiddenChanges.join("、") || "发色/服装/脸型"}`,
    )
    .join("\n");
}

/** 单页画面 Prompt：场景 + 角色锚定 + 风格 + AI 原生中文对白 */
export function buildComicPagePrompt(input: CreateRunInput, storyboard: ComicStoryboard, pageIndex: number): string {
  const page = storyboard.pages[pageIndex]!;
  const castText = page.cast
    .map((name) => storyboard.cast.find((member) => member.name === name))
    .filter((member): member is CharacterAnchor => Boolean(member))
    .map((member) => `【${member.name}】${member.appearance}；服装：${member.outfit}`)
    .join("\n");
  const dialogueText = page.dialogues
    .map((dialogue) => `${dialogue.type === "narration" ? "旁白" : dialogue.speaker}：${dialogue.text}`)
    .join("\n");
  return [
    `漫画页 ${pageIndex + 1}/${storyboard.pages.length}`,
    `主题：${input.topic}`,
    `场景：${page.scene}`,
    castText ? `出场角色（必须严格保持以下外貌与服装，跨页完全一致）：\n${castText}` : "出场角色：无",
    `画面内容：${page.visualPrompt}`,
    ...buildStyleHint(input),
    input.recipe === "strip_comic"
      ? "风格：四格漫画，单页四格、节奏起承转合，清晰勾线，适合手机阅读。"
      : "风格：单页多格科普漫画，清晰勾线，适合手机阅读。",
    `对白/旁白（必须逐字绘制到合适的对白气泡或旁白框中）：\n${dialogueText || "无"}`,
    "要求：图片直接完成画面、中文对白和旁白；中文必须清晰可读、无错字、无缺字，不要添加未提供的对白、标题、音效字、水印或 Logo；保持与其他页完全相同的角色形象与画风。",
  ].join("\n");
}

/**
 * 科普漫画管线（docs/phases/02 §4 简化实现）：
 * parse-input → generate-brief → generate-character（角色锚点+定妆图）
 * → generate-comic-storyboard（分镜+一致性检查）
 * → generate-comic-pages（按并发；渠道支持图生图时引用角色定妆图保持一致性）
 * → package-export
 *
 * 节点幂等语义与知识卡片一致：已成功节点跳过。
 */
export function registerComicPipeline(runner: JobRunner, deps: ComicPipelineDeps): void {
  runner.register(COMIC_RUN_KIND, async (ctx) => {
    if (!ctx.runId) throw new Error("comic_story_run requires runId");
    const run = await deps.runRepo.require(ctx.runId);
    const input = JSON.parse(run.inputJson) as CreateRunInput;
    const job = await deps.jobRepo.require(ctx.jobId);
    let targetPageIndex: number | undefined;
    if (job.payloadJson) {
      try {
        const payload = JSON.parse(job.payloadJson) as ComicJobPayload;
        if (Number.isInteger(payload.targetPageIndex) && (payload.targetPageIndex ?? -1) >= 0) {
          targetPageIndex = payload.targetPageIndex;
        }
      } catch {
        /* 无法解析的附加 payload 不影响普通 checkpoint 重试 */
      }
    }
    await deps.runRepo.updateStatus(run.id, "running");

    try {
      const selected = selectWorkflowRoutes(input, deps.textRoutes, deps.imageRoutes);
      await executeComicRun({ ...deps, ...selected }, ctx, run.id, input, targetPageIndex);
    } catch (error) {
      if (ctx.signal.aborted) await deps.runRepo.updateStatus(run.id, "cancelled");
      else {
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

async function executeComicRun(
  deps: ComicPipelineDeps,
  ctx: { signal: AbortSignal; onProgress: () => void },
  runId: string,
  input: CreateRunInput,
  targetPageIndex?: number,
): Promise<void> {
  /* parse-input */
  const parseDone = (await deps.runRepo.listNodeRuns(runId)).some(
    (n) => n.nodeName === "parse-input" && n.status === "succeeded",
  );
  if (!parseDone) {
    const node = await deps.runRepo.createNodeRun(runId, "parse-input");
    await deps.runRepo.startNode(node.id);
    await deps.runRepo.succeedNode(node.id, {
      outputRef: JSON.stringify({ recipe: input.recipe, aspectRatio: input.aspectRatio }),
    });
  }

  /* RunSnapshot */
  await deps.runRepo.setSnapshot(
    runId,
    JSON.stringify({
      recipe: input.recipe,
      concurrency: {
        channels: [
          ...deps.textRoutes.map((route) => ({ id: route.config.id, type: "text", max: route.config.concurrencyMax })),
          ...deps.imageRoutes.map((route) => ({ id: route.config.id, type: "image", max: route.config.concurrencyMax })),
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
  const brief = (
    await runStructured(
      deps,
      ctx,
      runId,
      "generate-brief",
      "ContentBrief",
    [
      `主题：${input.topic}`,
      "任务：为科普漫画生成 Content Brief（教学目标、核心结论、事实边界）。",
      input.sourceText ? `参考资料（事实只来自用户输入与资料）：\n<<<资料>>>\n${input.sourceText.slice(0, 6000)}` : "不得编造事实。",
    ].join("\n"),
    ) as { value: { coreMessage: string } }
  ).value;

  /* generate-character：角色锚点（LLM 节点由 runStructured 管理） */
  let cast: CharacterAnchor[];
  let characterRefBase64: string | null = null;
  let characterRefAssetId: string | null = null;
  {
    const anchors = (
      await runStructured(
        deps,
        ctx,
        runId,
        "generate-character",
        "ComicCast",
      [
        `主题：${input.topic}`,
        input.castDescription ? `主角设定（以此为基础细化）：${input.castDescription}` : "主角设定：请设计一个适合讲解该主题的科普向导角色。",
        "任务：生成 1–2 个角色的锚定描述（Character Bible 精简版）。",
        "要求：外貌/服装描述必须具体到可直接画出（发型、脸型、体型、颜色、标志物）；禁止变化项写明跨页不可改变的特征；refImagePrompt 生成正面全身定妆图的提示词（纯色背景、无文字）。",
      ].join("\n"),
      ) as { value: CharacterAnchor[] }
    ).value;
    cast = anchors;

    /* 定妆图：独立节点（文生图，所有渠道都支持；幂等） */
    const refNodes = await deps.runRepo.listNodeRuns(runId);
    const refNodeDone = refNodes.find(
      (n) => n.nodeName === "generate-character-ref" && n.status === "succeeded",
    );
    // 仅未结算的定妆图需要额度；失败节点若已有资产，也需要重新执行结算钩子。
    if (!refNodeDone) {
      await reserveCreditsToTarget(deps, runId, maxRouteCredits(deps.imageRoutes));
    }
    if (refNodeDone?.outputRef) {
      characterRefAssetId = (JSON.parse(refNodeDone.outputRef) as { assetId?: string }).assetId ?? null;
    } else {
      // 若上一次在图片落盘后仅因计费钩子失败，优先重试该节点的结算，不重复生成定妆图。
      const failedRefNode = refNodes.find(
        (n) => n.nodeName === "generate-character-ref" && n.status === "failed" && n.outputRef,
      );
      let failedRefAssetId: string | undefined;
      try {
        failedRefAssetId = failedRefNode?.outputRef
          ? (JSON.parse(failedRefNode.outputRef) as { assetId?: string }).assetId
          : undefined;
      } catch {
        failedRefAssetId = undefined;
      }
      const failedRefAsset = failedRefAssetId ? await deps.assetRepo.require(failedRefAssetId).catch(() => null) : null;
      if (failedRefNode && failedRefAsset && failedRefAsset.runId === runId && failedRefAsset.kind === "reference") {
        await deps.runRepo.succeedNode(failedRefNode.id, {
          outputRef: failedRefNode.outputRef ?? undefined,
          images: 1,
          credits: assetCredits(failedRefAsset.metadataJson),
        });
        characterRefAssetId = failedRefAsset.id;
      } else {
        const refNode = await deps.runRepo.createNodeRun(runId, "generate-character-ref");
        await deps.runRepo.startNode(refNode.id, {
          routeId: deps.imageRoutes[0]?.config.id,
          model: deps.imageRoutes[0]?.model,
        });
        const refPrompt = [
          `角色定妆图：${anchors.map((member) => member.name).join("、")}`,
          ...anchors.map((member) => `${member.name}：${member.appearance}；服装：${member.outfit}`),
          "要求：正面全身立绘、纯浅色背景、清晰勾线科普漫画风格；画面中不要出现任何文字。",
        ].join("\n");
        const generated = await generateImageWithFallbacks(deps, ctx, runId, refNode.id, refPrompt, null);
        const image = generated.image;
        const saved = await deps.assetStore.saveGeneratedImage(image, path.join("runs", runId, "character-ref.png"));
        const asset = await deps.assetRepo.create({
          runId,
          nodeRunId: refNode.id,
          kind: "reference",
          filePath: saved.filePath,
          mimeType: saved.mimeType,
          bytes: saved.bytes,
          checksum: saved.checksum,
          metadataJson: JSON.stringify({ purpose: "character-ref", creditsPerCall: routeCreditsPerCall(generated.route) }),
        });
        characterRefAssetId = asset.id;
        await deps.runRepo.succeedNode(refNode.id, {
          outputRef: JSON.stringify({ assetId: asset.id }),
          images: 1,
          credits: routeCreditsPerCall(generated.route),
          promptTokens: image.usage?.promptTokens ?? 0,
          completionTokens: image.usage?.completionTokens ?? 0,
        });
      }
    }
    if (characterRefAssetId) {
      const refAsset = await deps.assetRepo.require(characterRefAssetId);
      characterRefBase64 = fs.readFileSync(deps.assetStore.resolve(refAsset.filePath)).toString("base64");
    }
  }
  /* generate-comic-storyboard：分镜 + 一致性检查（节点由 runStructured 管理） */
  let storyboard: ComicStoryboard;
  let checks: Array<{ name: string; status: string; detail: string }> = [];
  {
    const castText = buildCharacterAnchorText(cast);
    const result = (await runStructured(
      deps,
      ctx,
      runId,
      "generate-comic-storyboard",
      "ComicStoryboard",
      buildComicStoryboardPrompt(input, brief, castText),
      ) as { value: ComicStoryboard; nodeId: string }
    );
    storyboard = result.value;
    // 归一化页码 + 一致性检查（strip_comic 允许 1–2 页四格）
    storyboard.pages.forEach((page, index) => {
      page.index = index;
    });
    checks = runComicConsistencyChecks(storyboard, input.recipe === "strip_comic" ? [1, 2] : [3, 6]);
    await deps.runRepo.setNodeOutput(result.nodeId, JSON.stringify({ value: storyboard, checks }));
    const failed = checks.filter((c) => c.status === "fail");
    if (failed.length > 0) {
      await deps.runRepo.failNode(result.nodeId, "invalid_request", `一致性检查未过：${failed.map((c) => c.detail).join("；")}`);
      throw new Error(`comic consistency check failed: ${failed.map((c) => c.detail).join("；")}`);
    }
  }

  const pageCount = storyboard.pages.length;

  /* generate-comic-pages：按并发；角色定妆图作为图生图参考（渠道支持时） */
  const failedPages: number[] = [];
  const editCapableRoutes = deps.imageRoutes.filter((route) => route.image.capabilities().imageEditSingle);
  const pagesToProcess = targetPageIndex === undefined
    ? storyboard.pages
    : storyboard.pages.filter((page) => page.index === targetPageIndex);
  if (targetPageIndex !== undefined && pagesToProcess.length === 0) {
    throw new Error(`comic page index out of range: ${targetPageIndex}`);
  }
  const pageNodes = await deps.runRepo.listNodeRuns(runId);
  let pendingPageCount = 0;
  for (const page of pagesToProcess) {
    const existing = await deps.assetRepo.latestForPage(runId, page.index);
    if (!existing) {
      pendingPageCount += 1;
      continue;
    }
    const linked = existing.nodeRunId ? pageNodes.find((node) => node.id === existing.nodeRunId) : undefined;
    if (linked?.status === "failed" && linked.outputRef) pendingPageCount += 1;
  }
  await reserveCreditsToTarget(deps, runId, pendingPageCount * maxRouteCredits(deps.imageRoutes));
  const tasks = pagesToProcess.map((page) => async () => {
    const existing = await deps.assetRepo.latestForPage(runId, page.index);
    if (existing) {
      const nodes = await deps.runRepo.listNodeRuns(runId);
      const linked = existing.nodeRunId ? nodes.find((node) => node.id === existing.nodeRunId) : undefined;
      if (linked?.status === "failed" && linked.outputRef) {
        let outputAssetId: string | undefined;
        try {
          outputAssetId = (JSON.parse(linked.outputRef) as { assetId?: string }).assetId;
        } catch {
          outputAssetId = undefined;
        }
        if (outputAssetId === existing.id) {
          await deps.runRepo.succeedNode(linked.id, {
            outputRef: linked.outputRef,
            images: 1,
            credits: assetCredits(existing.metadataJson),
          });
          return;
        }
      }
      return;
    }
    await generateComicPage(deps, ctx, {
      runId,
      input,
      storyboard,
      pageIndex: page.index,
      pageCount,
      characterRefBase64,
      editCapableRoutes,
      failedPages,
    });
  });
  await Promise.all(tasks.map((task) => task()));
  await throwIfAborted(deps, runId, ctx.signal);

  // 单页重试只执行目标页，但仍需保留其它缺失页的失败状态，避免误报整单成功。
  const incompletePages: number[] = [];
  for (const page of storyboard.pages) {
    if (!(await deps.assetRepo.latestForPage(runId, page.index))) incompletePages.push(page.index);
  }
  for (const pageIndex of incompletePages) {
    if (!failedPages.includes(pageIndex)) failedPages.push(pageIndex);
  }

  /* package-export：每次恢复都刷新 manifest，避免保留上一次失败页面清单 */
  const exportNode = await deps.runRepo.createNodeRun(runId, "package-export");
  await deps.runRepo.startNode(exportNode.id);
  const totals = await deps.runRepo.runTotals(runId);
  const exportDir = path.join(deps.exportsDir, runId);
  fs.mkdirSync(exportDir, { recursive: true });
  fs.writeFileSync(
    path.join(exportDir, "manifest.json"),
    JSON.stringify({ runId, input, storyboard, checks, pages: storyboard.pages.length, failedPages, usage: totals, generatedAt: toBeijingIsoString() }, null, 2),
  );
  await deps.runRepo.succeedNode(exportNode.id, { outputRef: JSON.stringify({ manifest: true }) });

  if (failedPages.length > 0) {
    const summary = `pages failed: ${failedPages.join(", ")}`;
    await deps.runRepo.updateStatus(runId, "failed", { errorSummary: summary });
    throw new Error(summary);
  }
  if (input.requireApproval) {
    await deps.runRepo.updateStatus(runId, "awaiting_approval");
    logger.info("comic run awaiting final approval", { runId, pages: pageCount });
    return;
  }
  await deps.runRepo.updateStatus(runId, "succeeded");
  logger.info("comic run completed", { runId, pages: pageCount });
}

async function generateComicPage(
  deps: ComicPipelineDeps,
  ctx: { signal: AbortSignal; onProgress: () => void },
  args: {
    runId: string;
    input: CreateRunInput;
    storyboard: ComicStoryboard;
    pageIndex: number;
    pageCount: number;
    characterRefBase64: string | null;
    editCapableRoutes: ImageRoute[];
    failedPages: number[];
  },
) {
  const { runId, input, storyboard, pageIndex } = args;
  const node = await deps.runRepo.createNodeRun(runId, "generate-comic-pages");
  await deps.runRepo.startNode(node.id, { routeId: deps.imageRoutes[0]?.config.id, model: deps.imageRoutes[0]?.model });
  const prompt = buildComicPagePrompt(input, storyboard, pageIndex);

  try {
    let usageAcc: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0 };
    let usedModel: string | null = null;
    let usedRoute: ImageRoute | null = null;
    const result = await withModelFallbacks({
      routes: args.editCapableRoutes.length > 0 ? args.editCapableRoutes : deps.imageRoutes,
      signal: ctx.signal,
      run: async (fallbackRoute) => {
        const route = (args.editCapableRoutes.length > 0 ? args.editCapableRoutes : deps.imageRoutes).find(
          (r) => r.config.id === fallbackRoute.config.id,
        )!;
        ctx.onProgress();
        let images;
        // 渠道支持图生图时，以角色定妆图为参考（身份锚定）
        if (route.image.capabilities().imageEditSingle && args.characterRefBase64) {
          images = await route.image.edit!({
            prompt,
            aspectRatio: input.aspectRatio,
            baseImage: { base64: args.characterRefBase64 },
            signal: ctx.signal,
          });
          usedModel = route.model;
          usedRoute = route;
        } else {
          images = await route.image.generate({ prompt, aspectRatio: input.aspectRatio, n: 1, signal: ctx.signal });
          usedModel = route.model;
          usedRoute = route;
        }
        usageAcc = mergeUsageLocal(usageAcc, images[0]?.usage);
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
    const saved = await deps.assetStore.saveGeneratedImage(
      imageToSave,
      path.join("runs", runId, "pages", `page-${pageIndex}.png`),
    );
    const asset = await deps.assetRepo.create({
      runId,
      nodeRunId: node.id,
      pageIndex,
      kind: "generated",
      filePath: saved.filePath,
      mimeType: saved.mimeType,
      bytes: saved.bytes,
      checksum: saved.checksum,
      metadataJson: JSON.stringify({
        mode: "comic",
        usedEdit: Boolean(args.characterRefBase64 && deps.imageRoutes.some((r) => r.image.capabilities().imageEditSingle)),
        model: usedModel,
        creditsPerCall: routeCreditsPerCall(usedRoute ?? deps.imageRoutes[0] ?? {}),
      }),
    });
    await deps.runRepo.succeedNode(node.id, {
      outputRef: JSON.stringify({ pageIndex, assetId: asset.id }),
      images: 1,
      credits: routeCreditsPerCall(usedRoute ?? deps.imageRoutes[0] ?? {}),
      model: usedModel ?? undefined,
      promptTokens: usageAcc.promptTokens,
      completionTokens: usageAcc.completionTokens,
      costUsd: usageAcc.costUsd,
    });
  } catch (error) {
    const aiError = toAiError(error);
    await deps.runRepo.failNode(node.id, aiError.category, aiError.message.slice(0, 400), {
      outputRef: JSON.stringify({ pageIndex }),
    });
    args.failedPages.push(pageIndex);
    logger.error("comic page failed", { runId, page: pageIndex, error: aiError.message.slice(0, 200) });
  }
}

/* ── 共享工具 ─────────────────────────────────────────────────── */

/**
 * 对原生直出图叠加 Brand Kit 水印/签名（「只对 generated 直出图叠加」规则；
 * 作品正文由图片模型直接完成；这里仅处理品牌水印/签名。
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

async function throwIfAborted(deps: ComicPipelineDeps, runId: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    await deps.runRepo.updateStatus(runId, "cancelled");
    throw new Error("run cancelled by user");
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

function mergeUsageLocal(acc: ModelUsage, incoming: ModelUsage | undefined): ModelUsage {
  if (!incoming) return acc;
  return {
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

async function generateImageWithFallbacks(
  deps: ComicPipelineDeps,
  ctx: { signal: AbortSignal; onProgress: () => void },
  runId: string,
  nodeRunId: string,
  prompt: string,
  _reference: null,
) {
  void _reference;
  // 科普漫画全部优先使用支持图生图的渠道（如 gpt-image-2），保证风格与角色一致
  const editCapable = deps.imageRoutes.filter((route) => route.image.capabilities().imageEditSingle);
  const routes = editCapable.length > 0 ? editCapable : deps.imageRoutes;
  let usageAcc: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0 };
  let usedRoute: ImageRoute | null = null;
  const result = await withModelFallbacks({
    routes,
    signal: ctx.signal,
    run: async (fallbackRoute) => {
      const route = deps.imageRoutes.find((r) => r.config.id === fallbackRoute.config.id)!;
      ctx.onProgress();
      const images = await route.image.generate({ prompt, aspectRatio: "1:1", n: 1, signal: ctx.signal });
      usedRoute = route;
      usageAcc = mergeUsageLocal(usageAcc, images[0]?.usage);
      return images;
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
  const image = result[0]!;
  return { image: { ...image, usage: usageAcc }, route: usedRoute ?? routes[0]! };
}

async function runStructured<T>(
  deps: ComicPipelineDeps,
  ctx: { signal: AbortSignal; onProgress: () => void },
  runId: string,
  nodeName: string,
  schemaName: string,
  prompt: string,
): Promise<{ value: T; nodeId: string }> {

  const existing = (await deps.runRepo.listNodeRuns(runId)).find(
    (n) => n.nodeName === nodeName && n.status === "succeeded",
  );
  if (existing?.outputRef) {
    try {
      return { value: (JSON.parse(existing.outputRef) as { value: T }).value, nodeId: existing.id };
    } catch {
      /* 重新生成 */
    }
  }
  const node = await deps.runRepo.createNodeRun(runId, nodeName);
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
            prompt,
            schemaName,
            schema: schemaFor(schemaName),
            signal: ctx.signal,
            onUsage: (usage: ModelUsage) => {
              usageAcc = mergeUsageLocal(usageAcc, usage);
            },
          });
          usedRoute = route;
          if (reserved) {
            await deps.captureModelCredits?.(runId, node.id, credits, route.model);
            reserved = false;
          }
          return result as T;
        } catch (error) {
          if (reserved && deps.releaseModelCredits) {
            await deps.releaseModelCredits(runId, credits).catch((releaseError) =>
              logger.error("release text model credits failed", { runId, nodeRunId: node.id, error: String(releaseError) }),
            );
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
      outputRef: JSON.stringify({ value, schemaName }),
      promptTokens: usageAcc.promptTokens,
      completionTokens: usageAcc.completionTokens,
      costUsd: usageAcc.costUsd,
    });
    return { value: value as T, nodeId: node.id };
  } catch (error) {
    const aiError = toAiError(error);
    await deps.runRepo.failNode(node.id, aiError.category, aiError.message.slice(0, 400));
    throw error;
  }
}

function schemaFor(schemaName: string): z.ZodType<unknown> {
  if (schemaName === "ContentBrief") {
    return z.object({
      topic: z.string(),
      audience: z.string(),
      objective: z.enum(["educate", "promote", "convert", "recommend"]),
      coreMessage: z.string(),
      evidence: z.array(z.object({ claim: z.string(), source: z.string().optional(), confidence: z.enum(["verified", "provided", "inferred"]) })),
      tone: z.array(z.string()),
      callToAction: z.string().optional(),
      prohibitedClaims: z.array(z.string()),
    });
  }
  if (schemaName === "ComicCast") {
    return z.array(CharacterAnchorSchema);
  }
  if (schemaName === "ComicStoryboard") {
    return ComicStoryboardSchema;
  }
  throw new Error(`unknown structured schema: ${schemaName}`);
}
