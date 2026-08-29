import fs from "node:fs";
import type { ComicStoryboard, Storyboard } from "@aai/shared-schemas";
import type { Runtime } from "./runtime";
import type { RunDetailPayload, RunListItem } from "@/lib/types";

interface NodeRow {
  id: string;
  nodeName: string;
  status: string;
  attempt: number;
  outputRef: string | null;
  errorSummary: string | null;
  model: string | null;
}

/** 从持久化状态推导运行列表（供 SSR 与 GET /api/runs 复用） */
export function listRunItems(runtime: Runtime, limit: number): RunListItem[] {
  return runtime.runRepo.list(limit).map((run) => {
    const input = JSON.parse(run.inputJson) as { topic: string; textRenderingMode: string };
    const nodes = runtime.runRepo.listNodeRuns(run.id) as unknown as NodeRow[];
    // 知识卡片 / 科普漫画两种分镜节点
    const storyboardNode =
      nodes.find((n) => n.nodeName === "generate-storyboard" && n.status === "succeeded") ??
      nodes.find((n) => n.nodeName === "generate-comic-storyboard" && n.status === "succeeded");
    let pageCount = 0;
    if (storyboardNode?.outputRef) {
      try {
        pageCount = ((JSON.parse(storyboardNode.outputRef) as { value: { slides?: unknown[]; pages?: unknown[] } }).value
          .slides ??
          (JSON.parse(storyboardNode.outputRef) as { value: { pages?: unknown[] } }).value.pages)?.length ?? 0;
      } catch {
        pageCount = 0;
      }
    }
    // 封面：第一页当前资产
    const cover = runtime.assetRepo.latestForPage(run.id, 0);
    return {
      runId: run.id,
      topic: input.topic,
      status: run.status as RunListItem["status"],
      mode: input.textRenderingMode as RunListItem["mode"],
      reviewStatus: run.reviewStatus as RunListItem["reviewStatus"],
      createdAt: run.createdAt,
      pageCount,
      coverAssetId: cover?.id ?? undefined,
    };
  });
}

/** 组装运行详情（供 SSR 与 GET /api/runs/:id 复用） */
export function buildRunDetail(runtime: Runtime, runId: string): RunDetailPayload | null {
  let run;
  try {
    run = runtime.runRepo.require(runId);
  } catch {
    return null;
  }
  const input = JSON.parse(run.inputJson) as RunDetailPayload["input"] & { brandKitId?: string };
  const nodes = runtime.runRepo.listNodeRuns(runId) as unknown as NodeRow[];
  const snapshot = run.snapshotJson
    ? (JSON.parse(run.snapshotJson) as {
        concurrency?: RunDetailPayload["concurrency"];
        routes?: Array<{ id: string; kind?: string; model: string }>;
        templateVersion?: string;
      })
    : null;

  // Storyboard 与页面状态（知识卡片 / 科普漫画两种节点名）
  const storyboardNode =
    nodes.find((n) => n.nodeName === "generate-storyboard" && n.status === "succeeded") ??
    nodes.find((n) => n.nodeName === "generate-comic-storyboard" && n.status === "succeeded");
  let storyboard: Storyboard | null = null;
  let comicStoryboard: ComicStoryboard | null = null;
  if (storyboardNode?.outputRef) {
    try {
      const value = (JSON.parse(storyboardNode.outputRef) as { value: unknown }).value;
      if (Array.isArray((value as { cast?: unknown }).cast)) {
        comicStoryboard = value as ComicStoryboard;
      } else {
        storyboard = value as Storyboard;
      }
    } catch {
      storyboard = null;
    }
  }

  // 页面状态以「每页当前资产」为准（返修后取最新版本，旧版本计入 Revision 链）
  const pageNodes = nodes.filter((n) => n.nodeName === "generate-images");
  const comicSlides = comicStoryboard?.pages ?? [];
  const pages: RunDetailPayload["pages"] = (
    storyboard?.slides ?? comicSlides.map((comicPage) => ({
      index: comicPage.index,
      role: "comic" as const,
      headline: comicPage.scene.slice(0, 24),
      body: comicPage.dialogues.map((d) => `${d.speaker}：${d.text}`),
      visualIntent: comicPage.visualPrompt,
      layoutHint: "",
    }))
  ).map((slide) => {
    const current = runtime.assetRepo.latestForPage(runId, slide.index);
    if (current) {
      const metadata = current.metadataJson ? (JSON.parse(current.metadataJson) as Record<string, unknown>) : {};
      // 页面模型优先读资产 metadata（回退链：合成节点 → 同页出图节点）
      const pageModelFromMeta =
        typeof metadata.model === "string" && metadata.model
          ? metadata.model
          : (() => {
              const generatedAsset = runtime
                .assetRepo.listByRun(runId)
                .filter((a) => a.pageIndex === slide.index && a.kind === "generated")
                .sort((a, b) => b.createdAt - a.createdAt)[0];
              const genMeta = generatedAsset?.metadataJson
                ? (JSON.parse(generatedAsset.metadataJson) as Record<string, unknown>)
                : {};
              if (typeof genMeta.model === "string" && genMeta.model) return genMeta.model;
              const genNode = generatedAsset?.nodeRunId
                ? nodes.find((n) => n.id === generatedAsset.nodeRunId)
                : undefined;
              return genNode?.model ?? undefined;
            })();
      return {
        index: slide.index,
        role: slide.role,
        headline: slide.headline,
        status: "ready" as const,
        assetId: current.id,
        mode: typeof metadata.mode === "string" ? metadata.mode : undefined,
        expectedCopy: Array.isArray(metadata.expectedCopy) ? (metadata.expectedCopy as string[]) : undefined,
        visualCheckPassed:
          typeof metadata.visualCheckPassed === "boolean" ? metadata.visualCheckPassed : undefined,
        revision: typeof metadata.revision === "number" ? metadata.revision : undefined,
        model: pageModelFromMeta,
      };
    }
    // 尚无当前资产：看是否有失败的页面节点（可重试）
    const failedNode = pageNodes.find((n) => {
      try {
        return (
          n.status === "failed" &&
          (JSON.parse(n.outputRef ?? "{}") as { pageIndex?: number }).pageIndex === slide.index
        );
      } catch {
        return false;
      }
    });
    return {
      index: slide.index,
      role: slide.role,
      headline: slide.headline,
      status: failedNode ? ("failed" as const) : ("pending" as const),
    };
  });

  const job = runtime.jobRepo.list(200).find((j) => j.runId === runId);
  const totals = runtime.runRepo.runTotals(runId);

  // 生成信息：输入 + 冻结快照 + 漫画定妆图
  const brandKitMeta = input.brandKit
    ? {
        name: input.brandKitId ? (runtime.brandKitRepo.list().find((k) => k.id === input.brandKitId)?.name ?? "已删除") : "自定义",
        themeId: input.brandKit.themeId,
        styleKeywords: input.brandKit.styleKeywords,
      }
    : null;
  const characterRefNode = nodes.find(
    (n) => n.nodeName === "generate-character-ref" && n.status === "succeeded",
  );
  const characterRefAssetId = characterRefNode?.outputRef
    ? (JSON.parse(characterRefNode.outputRef) as { assetId?: string }).assetId ?? null
    : null;

  return {
    runId,
    status: run.status as RunDetailPayload["status"],
    reviewStatus: run.reviewStatus as RunDetailPayload["reviewStatus"],
    reviewNote: run.reviewNote,
    errorSummary: run.errorSummary,
    createdAt: run.createdAt,
    input,
    concurrency: snapshot?.concurrency ?? null,
    totals,
    job: job
      ? { id: job.id, status: job.status, attempts: job.attempts, recoveries: job.recoveries }
      : null,
    nodes: nodes.map((n) => ({ nodeName: n.nodeName, status: n.status, attempt: n.attempt })),
    storyboardTitle: storyboard?.title ?? comicStoryboard?.title ?? null,
    generation: {
      recipe: input.recipe ?? "knowledge_cards",
      textRenderingMode: input.textRenderingMode,
      aspectRatio: input.aspectRatio,
      platform: input.platform,
      brandKit: brandKitMeta,
      // 生成信息-模型：以实际调用为准（含回退与重试），快照仅兜底
      ...(runtime.providerRepo.listUsedModels(runId).length > 0
        ? {
            routes: runtime.providerRepo.listUsedModels(runId).map((m) => ({
              id: m.routeId,
              kind: "used",
              model: m.model,
            })),
          }
        : {
            routes: (snapshot?.routes ?? []).map((r) => ({
              ...r,
              kind:
                r.kind ??
                (/imagine|image|dall/i.test(r.model)
                  ? "image"
                  : /deepseek|gpt-|grok-|o[134]/.test(r.model)
                    ? "text"
                    : "unknown"),
            })),
          }),
      templateVersion: snapshot?.templateVersion ?? null,
      characterRefAssetId,
    },
    pages,
  };
}

/** 读取资产文件（供资产下载路由复用） */
export function readAssetFile(runtime: Runtime, assetId: string): { body: fs.ReadStream; mimeType: string } | null {
  try {
    const asset = runtime.assetRepo.require(assetId);
    const fullPath = runtime.assetStore.resolve(asset.filePath);
    if (!fs.existsSync(fullPath)) return null;
    return { body: fs.createReadStream(fullPath), mimeType: asset.mimeType };
  } catch {
    return null;
  }
}
