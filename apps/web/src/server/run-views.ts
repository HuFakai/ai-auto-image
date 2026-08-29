import fs from "node:fs";
import type { Storyboard } from "@aai/shared-schemas";
import type { Runtime } from "./runtime";
import type { RunDetailPayload, RunListItem } from "@/lib/types";

interface NodeRow {
  id: string;
  nodeName: string;
  status: string;
  attempt: number;
  outputRef: string | null;
  errorSummary: string | null;
}

/** 从持久化状态推导运行列表（供 SSR 与 GET /api/runs 复用） */
export function listRunItems(runtime: Runtime, limit: number): RunListItem[] {
  return runtime.runRepo.list(limit).map((run) => {
    const input = JSON.parse(run.inputJson) as { topic: string; textRenderingMode: string };
    const nodes = runtime.runRepo.listNodeRuns(run.id) as unknown as NodeRow[];
    const storyboardNode = nodes.find((n) => n.nodeName === "generate-storyboard" && n.status === "succeeded");
    let pageCount = 0;
    if (storyboardNode?.outputRef) {
      try {
        pageCount = ((JSON.parse(storyboardNode.outputRef) as { value: Storyboard }).value.slides)?.length ?? 0;
      } catch {
        pageCount = 0;
      }
    }
    return {
      runId: run.id,
      topic: input.topic,
      status: run.status as RunListItem["status"],
      mode: input.textRenderingMode as RunListItem["mode"],
      createdAt: run.createdAt,
      pageCount,
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
  const input = JSON.parse(run.inputJson) as RunDetailPayload["input"];
  const nodes = runtime.runRepo.listNodeRuns(runId) as unknown as NodeRow[];
  const snapshot = run.snapshotJson
    ? (JSON.parse(run.snapshotJson) as { concurrency?: RunDetailPayload["concurrency"] })
    : null;

  // Storyboard 与页面状态
  const storyboardNode = nodes.find((n) => n.nodeName === "generate-storyboard" && n.status === "succeeded");
  let storyboard: Storyboard | null = null;
  if (storyboardNode?.outputRef) {
    try {
      storyboard = (JSON.parse(storyboardNode.outputRef) as { value: Storyboard }).value;
    } catch {
      storyboard = null;
    }
  }

  const pageNodes = nodes.filter((n) => n.nodeName === "generate-images");
  const pages: RunDetailPayload["pages"] = (storyboard?.slides ?? []).map((slide) => {
    const node = pageNodes.find((n) => {
      try {
        return (JSON.parse(n.outputRef ?? "{}") as { pageIndex?: number }).pageIndex === slide.index;
      } catch {
        return false;
      }
    });
    if (!node) {
      return { index: slide.index, role: slide.role, headline: slide.headline, status: "pending" as const };
    }
    if (node.status === "failed") {
      return {
        index: slide.index,
        role: slide.role,
        headline: slide.headline,
        status: "failed" as const,
      };
    }
    const output = JSON.parse(node.outputRef ?? "{}") as { assetId?: string };
    const asset = output.assetId ? runtime.assetRepo.listByRun(runId).find((a) => a.id === output.assetId) : undefined;
    const metadata = asset?.metadataJson ? (JSON.parse(asset.metadataJson) as Record<string, unknown>) : {};
    return {
      index: slide.index,
      role: slide.role,
      headline: slide.headline,
      status: "ready" as const,
      assetId: output.assetId,
      mode: typeof metadata.mode === "string" ? metadata.mode : undefined,
      expectedCopy: Array.isArray(metadata.expectedCopy) ? (metadata.expectedCopy as string[]) : undefined,
      visualCheckPassed: typeof metadata.visualCheckPassed === "boolean" ? metadata.visualCheckPassed : undefined,
    };
  });
  // Storyboard 尚未生成时，已存在的页面节点也要展示
  if (!storyboard) {
    for (const node of pageNodes) {
      try {
        const output = JSON.parse(node.outputRef ?? "{}") as { pageIndex?: number };
        if (output.pageIndex === undefined) continue;
        if (pages.some((p) => p.index === output.pageIndex)) continue;
        pages.push({
          index: output.pageIndex,
          role: "content",
          headline: "（生成中）",
          status: node.status === "failed" ? "failed" : "pending",
        });
      } catch {
        /* ignore */
      }
    }
    pages.sort((a, b) => a.index - b.index);
  }

  const job = runtime.jobRepo.list(200).find((j) => j.runId === runId);
  const totals = runtime.runRepo.runTotals(runId);

  return {
    runId,
    status: run.status as RunDetailPayload["status"],
    errorSummary: run.errorSummary,
    createdAt: run.createdAt,
    input,
    concurrency: snapshot?.concurrency ?? null,
    totals,
    job: job
      ? { id: job.id, status: job.status, attempts: job.attempts, recoveries: job.recoveries }
      : null,
    nodes: nodes.map((n) => ({ nodeName: n.nodeName, status: n.status, attempt: n.attempt })),
    storyboardTitle: storyboard?.title ?? null,
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
