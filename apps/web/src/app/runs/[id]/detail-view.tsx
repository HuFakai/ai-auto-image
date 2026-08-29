"use client";

import { useCallback, useEffect, useState } from "react";
import type { RunDetailPayload, RunDetailPage } from "@/lib/types";

const nodeLabels: Record<string, string> = {
  "parse-input": "解析输入",
  "generate-brief": "内容 Brief",
  "generate-storyboard": "Storyboard",
  "generate-images": "生成页面",
  "render-slides": "确定性排版",
  "package-export": "装订导出",
};

const nodeOrder = [
  "parse-input",
  "generate-brief",
  "generate-storyboard",
  "generate-images",
  "render-slides",
  "package-export",
];

function runStamp(status: string): { text: string; className: string } {
  switch (status) {
    case "succeeded":
      return { text: "已讫", className: "stamp text-seal" };
    case "running":
      return { text: "制中", className: "stamp text-seal animate-pulse" };
    case "queued":
      return { text: "待排", className: "stamp stamp-quiet text-ink-faint" };
    case "failed":
      return { text: "作废", className: "stamp text-ink" };
    case "cancelled":
      return { text: "已废", className: "stamp stamp-quiet text-ink-faint" };
    default:
      return { text: status, className: "stamp stamp-quiet text-ink-faint" };
  }
}

export function RunDetailView({ initial }: { initial: RunDetailPayload }) {
  const [detail, setDetail] = useState(initial);
  const [cancelling, setCancelling] = useState(false);

  const active = detail.status === "running" || detail.status === "queued";

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/runs/${initial.runId}`, { cache: "no-store" });
      if (response.ok) setDetail((await response.json()) as RunDetailPayload);
    } catch {
      /* 下一轮再取 */
    }
  }, [initial.runId]);

  useEffect(() => {
    const timer = setInterval(refresh, active ? 3000 : 15000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    await fetch(`/api/runs/${initial.runId}/cancel`, { method: "POST" });
    await refresh();
    setCancelling(false);
  }

  const readyCount = detail.pages.filter((page) => page.status === "ready").length;
  const failedCount = detail.pages.filter((page) => page.status === "failed").length;
  const stamp = runStamp(detail.status);

  return (
    <div className="space-y-12 pt-10">
      {/* 标题 */}
      <section className="rise">
        <div className="flex items-start justify-between gap-4">
          <p className="kicker pt-1">
            RUN · {detail.runId.slice(4, 12)} ·{" "}
            {new Date(detail.createdAt).toLocaleString("zh-CN", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
          <span className={stamp.className}>{stamp.text}</span>
        </div>
        <h1 className="mt-3 font-display text-3xl font-black leading-snug sm:text-4xl">
          {detail.storyboardTitle ?? detail.input.topic}
        </h1>
        <p className="mt-3 font-mono text-xs text-ink-soft">
          {detail.input.aspectRatio} · {detail.input.platform} ·{" "}
          {detail.input.textRenderingMode === "native" ? "原生中文" : "确定性排版"}
          {detail.concurrency
            ? ` · 并发 ${detail.concurrency.effective}（请求 ${detail.concurrency.requested} / 上限 ${detail.concurrency.serverMax}）`
            : ""}
          {active ? ` · ${readyCount}/${detail.pages.length || "?"}` : ""}
        </p>
        {active && (
          <button
            className="btn-ghost mt-4 px-4 py-1.5 font-mono text-xs"
            onClick={() => void cancel()}
            disabled={cancelling}
          >
            {cancelling ? "作废中…" : "作废本次运行"}
          </button>
        )}
      </section>

      {/* 工序目录 */}
      <section className="rise" style={{ animationDelay: "60ms" }}>
        <div className="rule-double mb-4 pt-2">
          <h2 className="font-display text-lg font-bold">工序</h2>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-0 sm:grid-cols-3">
          {nodeOrder
            .filter((name) => name !== "render-slides" || detail.input.textRenderingMode === "deterministic")
            .map((name, index) => {
              const node = detail.nodes.find((n) => n.nodeName === name);
              const status = node?.status ?? "pending";
              return (
                <div
                  key={name}
                  className="flex items-baseline justify-between border-b border-line py-2.5"
                >
                  <span className="text-sm">
                    <span className="mr-2 font-mono text-[11px] text-ink-faint">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {nodeLabels[name] ?? name}
                    {node && node.attempt > 1 ? (
                      <span className="ml-1 font-mono text-[10px] text-seal">×{node.attempt}</span>
                    ) : null}
                  </span>
                  <span
                    className={`font-mono text-[11px] ${
                      status === "succeeded"
                        ? "text-seal"
                        : status === "running"
                          ? "text-seal animate-pulse"
                          : status === "failed"
                            ? "text-ink line-through"
                            : "text-ink-faint"
                    }`}
                  >
                    {status === "succeeded" ? "✓" : status === "running" ? "…" : status === "failed" ? "✗" : "—"}
                  </span>
                </div>
              );
            })}
        </div>
      </section>

      {detail.errorSummary && (
        <p className="border border-seal/40 bg-seal/5 px-5 py-3 font-mono text-xs text-seal">
          {detail.errorSummary}
        </p>
      )}

      {/* 页面画廊：相纸 */}
      <section className="rise" style={{ animationDelay: "120ms" }}>
        <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-lg font-bold">页面</h2>
          <span className="kicker">
            {readyCount} 已成{failedCount > 0 ? ` · ${failedCount} 失败` : ""}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-7 sm:grid-cols-2 lg:grid-cols-3">
          {detail.pages.map((page, index) => (
            <PageFrame key={page.index} page={page} no={index + 1} />
          ))}
          {detail.pages.length === 0 && detail.status !== "failed" && (
            <p className="col-span-full border border-dashed border-line-dark px-6 py-12 text-center text-sm text-ink-faint">
              等待 Storyboard 排定…
            </p>
          )}
        </div>
      </section>

      {/* 版权页 */}
      <section className="rise border-t-2 border-ink pt-5" style={{ animationDelay: "180ms" }}>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Metric label="TOKENS" value={detail.totals.totalTokens.toLocaleString()} />
          <Metric label="IMAGES" value={String(detail.totals.images)} />
          <Metric label="COST (USD)" value={`$${detail.totals.costUsd.toFixed(4)}`} />
          <Metric
            label="JOB"
            value={
              detail.job
                ? `${detail.job.status} · 试 ${detail.job.attempts} · 复 ${detail.job.recoveries}`
                : "—"
            }
          />
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="field-label">{label}</p>
      <p className="mt-1 font-mono text-sm">{value}</p>
    </div>
  );
}

function PageFrame({ page, no }: { page: RunDetailPage; no: number }) {
  if (page.status === "ready" && page.assetId) {
    return (
      <figure className="photo-frame frame-ready p-2.5 pb-0">
        <img
          src={`/api/assets/${page.assetId}`}
          alt={`第 ${no} 页：${page.headline}`}
          className="w-full border border-line/60"
        />
        <figcaption className="flex items-center justify-between px-1 py-2.5">
          <span className="font-mono text-[10px] text-ink-faint">
            图{String(no).padStart(2, "0")} · {page.role}
          </span>
          <span className="truncate pl-2 text-xs text-ink-soft">{page.headline}</span>
          {page.mode === "native" && page.visualCheckPassed === false && (
            <span className="font-mono text-[10px] text-seal" title="文字审查未通过：可单页重试或切换确定性渲染">
              字⚠
            </span>
          )}
        </figcaption>
      </figure>
    );
  }
  if (page.status === "failed") {
    return (
      <div className="photo-frame flex aspect-[3/4] flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="stamp text-ink line-through">作废</span>
        <p className="font-mono text-xs text-ink-soft">第 {no} 页生成失败</p>
        <p className="text-[11px] leading-relaxed text-ink-faint">
          任务会自动重试该页；其余页面不受影响。
        </p>
      </div>
    );
  }
  return (
    <div className="photo-frame frame-pending flex aspect-[3/4] flex-col items-center justify-center gap-3 p-6">
      <span className="font-display text-5xl font-black text-ink-faint/40">
        {String(no).padStart(2, "0")}
      </span>
      <p className="truncate px-4 text-xs text-ink-soft">{page.headline}</p>
      <span className="font-mono text-[10px] tracking-[0.3em] text-seal/70">制中…</span>
    </div>
  );
}
