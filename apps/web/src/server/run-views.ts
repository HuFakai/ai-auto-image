import fs from "node:fs";
import { normalizeSlideIndices, resolveSlideLayout } from "@aai/shared-schemas";
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
export async function listRunItems(
  runtime: Runtime,
  limit: number,
  /** 非 admin 传用户 id，仅返回其作品；admin/null 返回全部 */
  viewerUserId: string | null = null,
): Promise<RunListItem[]> {
  const runs = await runtime.runRepo.listForUser(viewerUserId, limit);
  const items: RunListItem[] = [];
  for (const run of runs) {
    const input = JSON.parse(run.inputJson) as { topic: string; textRenderingMode: string };
    const nodes = (await runtime.runRepo.listNodeRuns(run.id)) as unknown as NodeRow[];
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
    const cover = await runtime.assetRepo.latestForPage(run.id, 0);
    items.push({
      runId: run.id,
      topic: input.topic,
      status: run.status as RunListItem["status"],
      mode: input.textRenderingMode as RunListItem["mode"],
      reviewStatus: run.reviewStatus as RunListItem["reviewStatus"],
      createdAt: run.createdAt,
      pageCount,
      coverAssetId: cover?.id ?? undefined,
    });
  }
  return items;
}

/** 组装运行详情（供 SSR 与 GET /api/runs/:id 复用） */
export async function buildRunDetail(runtime: Runtime, runId: string): Promise<RunDetailPayload | null> {
  let run;
  try {
    run = await runtime.runRepo.require(runId);
  } catch {
    return null;
  }
  const input = JSON.parse(run.inputJson) as RunDetailPayload["input"] & { brandKitId?: string };
  const nodes = (await runtime.runRepo.listNodeRuns(runId)) as unknown as NodeRow[];
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
        // 防御：comic 管线已归一化，这里再统一一次（存量/异常数据兜底）
        comicStoryboard.pages.forEach((page, index) => {
          page.index = index;
        });
      } else {
        // LLM 可能输出 1-based 页码：统一按数组下标归一化，防止页文与图片错位
        storyboard = normalizeSlideIndices(value as Storyboard);
      }
    } catch {
      storyboard = null;
    }
  }

  // 页面状态以「每页当前资产」为准（返修后取最新版本，旧版本计入 Revision 链）
  const pageNodes = nodes.filter((n) => n.nodeName === "generate-images");
  const comicSlides = comicStoryboard?.pages ?? [];
  // 该 Run 全量资产提前取一次（回调内内存查找，避免每页重复 listByRun）
  const allAssets = await runtime.assetRepo.listByRun(runId);
  const pages: RunDetailPayload["pages"] = await Promise.all(
    (storyboard?.slides ?? comicSlides.map((comicPage) => ({
      index: comicPage.index,
      role: "comic" as const,
      headline: comicPage.scene.slice(0, 24),
      body: comicPage.dialogues.map((d) => `${d.speaker}：${d.text}`),
      visualIntent: comicPage.visualPrompt,
      layoutHint: "",
    }))).map(async (slide) => {
      const current = await runtime.assetRepo.latestForPage(runId, slide.index);
      if (current) {
        const metadata = current.metadataJson ? (JSON.parse(current.metadataJson) as Record<string, unknown>) : {};
        // 页面模型优先读资产 metadata（回退链：合成节点 → 同页出图节点）
        let pageModelFromMeta: string | undefined;
        if (typeof metadata.model === "string" && metadata.model) {
          pageModelFromMeta = metadata.model;
        } else {
          const generatedAsset = allAssets
            .filter((a) => a.pageIndex === slide.index && a.kind === "generated")
            .sort((a, b) => b.createdAt - a.createdAt)[0];
          const genMeta = generatedAsset?.metadataJson
            ? (JSON.parse(generatedAsset.metadataJson) as Record<string, unknown>)
            : {};
          if (typeof genMeta.model === "string" && genMeta.model) {
            pageModelFromMeta = genMeta.model;
          } else {
            const genNode = generatedAsset?.nodeRunId
              ? nodes.find((n) => n.id === generatedAsset.nodeRunId)
              : undefined;
            pageModelFromMeta = genNode?.model ?? undefined;
          }
        }
        return {
          index: slide.index,
          role: slide.role,
          headline: slide.headline,
          layout: resolveSlideLayout({
            layout: (slide as { layout?: string }).layout,
            layoutData: (slide as { layoutData?: unknown }).layoutData,
          }).layout,
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
    }),
  );

  const job = await runtime.jobRepo.findByRunId(runId);
  const totals = await runtime.runRepo.runTotals(runId);

  // 封面候选（kind="cover"、未被替代），按 variant 排序；漫画类型自然为空
  const covers: RunDetailPayload["covers"] = allAssets
    .filter((a) => a.kind === "cover" && a.supersededAt === null)
    .map((a) => {
      const meta = a.metadataJson ? (JSON.parse(a.metadataJson) as Record<string, unknown>) : {};
      return {
        assetId: a.id,
        variant: typeof meta.variant === "number" ? meta.variant : 0,
        hookTitle: typeof meta.hookTitle === "string" ? meta.hookTitle : "",
        styleNote: typeof meta.styleNote === "string" ? meta.styleNote : "",
      };
    })
    .sort((a, b) => a.variant - b.variant);
  // cover_generate 作业是否仍在排队/执行（决定详情页"封面生成中"状态）
  const coverJob = await runtime.jobRepo.findLatestByRunIdAndKind(runId, "cover_generate");
  const coverJobPending =
    coverJob !== null && ["queued", "retry_waiting", "running"].includes(coverJob.status);

  // 生成信息：输入 + 冻结快照 + 漫画定妆图
  let brandKitMeta: RunDetailPayload["generation"]["brandKit"] = null;
  if (input.brandKit) {
    let name = "自定义";
    if (input.brandKitId) {
      const kits = await runtime.brandKitRepo.list();
      name = kits.find((k) => k.id === input.brandKitId)?.name ?? "已删除";
    }
    brandKitMeta = {
      name,
      themeId: input.brandKit.themeId,
      styleKeywords: input.brandKit.styleKeywords,
    };
  }
  const characterRefNode = nodes.find(
    (n) => n.nodeName === "generate-character-ref" && n.status === "succeeded",
  );
  const characterRefAssetId = characterRefNode?.outputRef
    ? (JSON.parse(characterRefNode.outputRef) as { assetId?: string }).assetId ?? null
    : null;
  const usedModels = await runtime.providerRepo.listUsedModels(runId);

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
    covers,
    selectedCoverAssetId: run.selectedCoverAssetId,
    coverJobPending,
    generation: {
      recipe: input.recipe ?? "knowledge_cards",
      textRenderingMode: input.textRenderingMode,
      aspectRatio: input.aspectRatio,
      platform: input.platform,
      brandKit: brandKitMeta,
      // 生成信息-模型：以实际调用为准（含回退与重试），快照仅兜底
      ...(usedModels.length > 0
        ? {
            routes: usedModels.map((m) => ({
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
export async function readAssetFile(
  runtime: Runtime,
  assetId: string,
): Promise<{ body: fs.ReadStream; mimeType: string } | null> {
  try {
    const asset = await runtime.assetRepo.require(assetId);
    const fullPath = runtime.assetStore.resolve(asset.filePath);
    if (!fs.existsSync(fullPath)) return null;
    return { body: fs.createReadStream(fullPath), mimeType: asset.mimeType };
  } catch {
    return null;
  }
}
