"use client";

import { useCallback, useEffect, useState } from "react";
import type { RunDetailPage, RunDetailPayload } from "@/lib/types";

function runStamp(status: string): { text: string; className: string } {
  switch (status) {
    case "awaiting_approval":
      return { text: "待批", className: "stamp text-amber" };
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
  const [exporting, setExporting] = useState(false);
  const [editingPage, setEditingPage] = useState<number | null>(null);

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
    if (active || editingPage !== null) {
      const timer = setInterval(refresh, 3000);
      return () => clearInterval(timer);
    }
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [active, editingPage, refresh]);

  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    await fetch(`/api/runs/${initial.runId}/cancel`, { method: "POST" });
    await refresh();
    setCancelling(false);
  }

  function exportZip() {
    if (exporting) return;
    setExporting(true);
    // 下载由浏览器处理；按钮短暂禁用防重复
    window.location.assign(`/api/runs/${initial.runId}/export`);
    setTimeout(() => setExporting(false), 2500);
  }

  async function review(status: "approved" | "rejected") {
    await fetch(`/api/runs/${initial.runId}/review`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await refresh();
  }

  const readyCount = detail.pages.filter((page) => page.status === "ready").length;
  const failedCount = detail.pages.filter((page) => page.status === "failed").length;
  const stamp = runStamp(detail.status);
  const isDeterministic = detail.input.textRenderingMode === "deterministic";

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
          {isDeterministic ? "确定性排版" : "原生中文"}
          {detail.concurrency
            ? ` · 并发 ${detail.concurrency.effective}（请求 ${detail.concurrency.requested} / 上限 ${detail.concurrency.serverMax}）`
            : ""}
          {active ? ` · ${readyCount}/${detail.pages.length || "?"}` : ""}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {active ? (
            <button
              className="btn-ghost px-4 py-1.5 font-mono text-xs"
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              {cancelling ? "作废中…" : "作废本次运行"}
            </button>
          ) : detail.status === "awaiting_approval" ? (
            <button
              className="btn-ink px-5 py-2 font-mono text-xs tracking-[0.15em]"
              onClick={async () => {
                await fetch(`/api/runs/${initial.runId}/review`, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ status: "approved" }),
                });
                await refresh();
              }}
            >
              确认终稿（放行导出）
            </button>
          ) : detail.status === "succeeded" ? (
            <>
              <button className="btn-ink px-5 py-2 font-mono text-xs tracking-[0.15em]" onClick={exportZip} disabled={exporting}>
                {exporting ? "装订中…" : "导出 ZIP（图片 + 发布文案）"}
              </button>
              {detail.reviewStatus !== "approved" && (
                <button className="btn-ghost px-4 py-2 font-mono text-xs hover:!border-seal hover:!text-seal" onClick={() => void review("approved")}>
                  评审通过
                </button>
              )}
              {detail.reviewStatus !== "rejected" && (
                <button
                  className="btn-ghost px-4 py-2 font-mono text-xs"
                  onClick={() => void review("rejected")}
                >
                  评审驳回
                </button>
              )}
              {detail.reviewStatus !== "pending" && (
                <span className="font-mono text-[11px] text-ink-faint">
                  当前评审：{detail.reviewStatus === "approved" ? "已通过" : "已驳回"}
                  {detail.reviewNote ? ` · ${detail.reviewNote}` : ""}
                </span>
              )}
            </>
          ) : null}
        </div>
      </section>

      {detail.errorSummary && (
        <p className="border border-seal/40 bg-seal/5 px-5 py-3 font-mono text-xs text-seal">
          {detail.errorSummary}
        </p>
      )}

      {/* 页面画廊 */}
      <section className="rise" style={{ animationDelay: "120ms" }}>
        <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-lg font-bold">页面</h2>
          <span className="kicker">
            {readyCount} 已成{failedCount > 0 ? ` · ${failedCount} 失败` : ""}
            {detail.pages.some((p) => (p.revision ?? 1) > 1) ? " · 含返修版本" : ""}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-7 sm:grid-cols-2 lg:grid-cols-3">
          {detail.pages.map((page, index) => (
            <PageFrame
              key={page.index}
              page={page}
              no={index + 1}
              isDeterministic={isDeterministic}
              editing={editingPage === page.index}
              onToggleEdit={() => setEditingPage(editingPage === page.index ? null : page.index)}
              onDone={async () => {
                setEditingPage(null);
                await refresh();
              }}
            />
          ))}
          {detail.pages.length === 0 && detail.status !== "failed" && (
            <p className="col-span-full border border-dashed border-line-dark px-6 py-12 text-center text-sm text-ink-faint">
              等待 Storyboard 排定…
            </p>
          )}
        </div>
      </section>

      {/* 生成信息（全部参数可追溯） */}
      <section className="rise border-t-2 border-ink pt-5" style={{ animationDelay: "180ms" }}>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-display text-lg font-bold">生成信息</h2>
          <span className="kicker">COLOPHON · 全参数可追溯</span>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-0 sm:grid-cols-3">
          <InfoRow label="内容类型" value={detail.generation.recipe === "comic_story" ? "科普漫画" : "知识卡片"} />
          <InfoRow label="文字模式" value={detail.generation.textRenderingMode === "native" ? "原生中文（模型出图）" : "确定性排版（程序合成）"} />
          <InfoRow label="比例 · 平台" value={`${detail.generation.aspectRatio} · ${detail.generation.platform}`} />
          <InfoRow
            label="Brand Kit"
            value={
              detail.generation.brandKit
                ? `${detail.generation.brandKit.name}（${detail.generation.brandKit.themeId}）${
                    detail.generation.brandKit.styleKeywords.length
                      ? ` · ${detail.generation.brandKit.styleKeywords.join("、")}`
                      : ""
                  }`
                : "未使用"
            }
          />
          <InfoRow
            label="文本模型"
            value={detail.generation.routes.filter((r) => r.kind !== "mock" && (r.model.includes("deepseek") || r.model.includes("gpt-") || r.model.includes("grok-4") || r.model.includes("o"))).length > 0
              ? detail.generation.routes
                  .filter((r) => r.model.includes("deepseek") || /gpt-[45o]/.test(r.model) || /grok-[234]/.test(r.model))
                  .map((r) => `${r.model}（${r.kind}）`)
                  .join(" → ") || "—"
              : "—"}
          />
          <InfoRow
            label="图片模型"
            value={
              detail.generation.routes
                .filter((r) => /imagine|image|dall/i.test(r.model))
                .map((r) => `${r.model}（${r.kind}${/imagine-image-2|gpt-image/.test(r.model) ? ", 图生图" : ""}）`)
                .join(" → ") || "—"
            }
          />
          <InfoRow
            label="并发（请求/生效/上限）"
            value={
              detail.concurrency
                ? `${detail.concurrency.requested} / ${detail.concurrency.effective} / ${detail.concurrency.serverMax}`
                : "—"
            }
          />
          <InfoRow label="排版模板" value={detail.generation.templateVersion ?? "—"} />
          <InfoRow
            label="角色定妆图"
            value={
              detail.generation.characterRefAssetId ? (
                <a
                  href={`/api/assets/${detail.generation.characterRefAssetId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-seal underline"
                >
                  查看参考图
                </a>
              ) : (
                "—"
              )
            }
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-5 border-t border-line pt-4 sm:grid-cols-4">
          <Metric label="TOKENS" value={detail.totals.totalTokens.toLocaleString()} />
          <Metric label="IMAGES" value={String(detail.totals.images)} />
          <Metric label="COST (USD)" value={`$${detail.totals.costUsd.toFixed(4)}`} />
          <Metric
            label="JOB"
            value={detail.job ? `${detail.job.status} · 试 ${detail.job.attempts} · 复 ${detail.job.recoveries}` : "—"}
          />
        </div>
      </section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-2">
      <span className="shrink-0 text-xs text-ink-soft">{label}</span>
      <span className="truncate text-right font-mono text-[12px] text-ink">{value}</span>
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

function PageFrame({
  page,
  no,
  isDeterministic,
  editing,
  onToggleEdit,
  onDone,
}: {
  page: RunDetailPage;
  no: number;
  isDeterministic: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onDone: () => Promise<void>;
}) {
  if (page.status === "ready" && page.assetId) {
    const revised = (page.revision ?? 1) > 1;
    return (
      <figure className="photo-frame p-2.5 pb-0">
        <div className={revised ? "" : "frame-ready"}>
          <img
            src={`/api/assets/${page.assetId}`}
            alt={`第 ${no} 页：${page.headline}`}
            className="w-full border border-line/60"
          />
        </div>
        <figcaption className="flex items-center justify-between px-1 py-2.5">
          <span className="font-mono text-[10px] text-ink-faint" title={page.model ? `生成模型：${page.model}` : undefined}>
            图{String(no).padStart(2, "0")} · {page.role}
            {revised ? ` · 第${page.revision}版` : ""}
            {page.model ? ` · ${page.model}` : ""}
          </span>
          <span className="truncate px-2 text-xs text-ink-soft">{page.headline}</span>
          <button className="btn-ghost shrink-0 px-2 py-0.5 font-mono text-[10px]" onClick={onToggleEdit}>
            {editing ? "收起" : "返修"}
          </button>
        </figcaption>
        {editing && (
          <RegenPanel page={page} no={no} isDeterministic={isDeterministic} onDone={onDone} />
        )}
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

/** 返修面板：改文案 → deterministic 免费重排 / native 或强改画面时重新出图（提示费用） */
function RegenPanel({
  page,
  no,
  isDeterministic,
  onDone,
}: {
  page: RunDetailPage;
  no: number;
  isDeterministic: boolean;
  onDone: () => Promise<void>;
}) {
  const [headline, setHeadline] = useState(page.headline);
  const [bodyText, setBodyText] = useState((page.expectedCopy ?? []).slice(1).join("\n"));
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const copyChanged = headline !== page.headline || bodyText !== (page.expectedCopy ?? []).slice(1).join("\n");

  async function rerender() {
    if (busy) return;
    setBusy("rerender");
    setMessage(null);
    try {
      const response = await fetch(`/api/runs/${pageAssetScope}/pages/${page.index}/rerender`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ headline, body: bodyText.split("\n").map((l) => l.trim()).filter(Boolean) }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      await onDone();
      setMessage("已重新排版。");
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : caught}`);
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    if (busy) return;
    setBusy("regen");
    setMessage(null);
    try {
      const response = await fetch(`/api/runs/${pageAssetScope}/pages/${page.index}/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          headline,
          body: bodyText.split("\n").map((l) => l.trim()).filter(Boolean),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      setMessage("返修任务已入队，生成完成后自动刷新（会产生一次图片调用费用）。");
      await onDone();
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : caught}`);
    } finally {
      setBusy(null);
    }
  }

  // 从当前 URL 取 runId（详情页路径 /runs/:id）
  const pageAssetScope = typeof window !== "undefined" ? window.location.pathname.split("/")[2] ?? "" : "";

  return (
    <div className="border-t border-line bg-paper-deep/40 p-3">
      <span className="field-label">第 {no} 页返修</span>
      <input
        className="field-input mt-1 !text-sm"
        value={headline}
        onChange={(event) => setHeadline(event.target.value)}
        placeholder="标题"
      />
      <textarea
        className="field-input mt-2 min-h-[60px] resize-y font-mono !text-[11px]"
        value={bodyText}
        onChange={(event) => setBodyText(event.target.value)}
        placeholder="正文（每行一条）"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {isDeterministic && (
          <button
            className="btn-ghost px-3 py-1.5 font-mono text-[11px]"
            onClick={() => void rerender()}
            disabled={Boolean(busy) || !copyChanged}
            title="只改文字重新排版：不调用模型、零费用"
          >
            {busy === "rerender" ? "排版中…" : "重新排版（免费）"}
          </button>
        )}
        <button
          className="btn-ink px-3 py-1.5 font-mono text-[11px]"
          onClick={() => void regenerate()}
          disabled={Boolean(busy)}
          title={isDeterministic ? "重新生成视觉层并排版：一次图片调用" : "按新文案重新出图：一次图片调用"}
        >
          {busy === "regen" ? "返修中…" : isDeterministic ? "重出画面并排版（收费）" : "重新生成本页（收费）"}
        </button>
        {!isDeterministic && copyChanged && (
          <span className="font-mono text-[10px] text-seal">改文案需重新出图</span>
        )}
      </div>
      {message && <p className="mt-2 font-mono text-[10px] text-ink-soft">{message}</p>}
    </div>
  );
}
