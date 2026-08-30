"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LAYOUT_LABELS } from "@aai/shared-schemas";
import type { Recipe } from "@aai/shared-schemas";
import type { RunDetailPage, RunDetailPayload } from "@/lib/types";
import { RECIPE_LABELS } from "@/lib/types";

/** 适配目标（小红书为原始平台不参与适配）；与 shared-schemas PLATFORM_PRESETS 对齐 */
const ADAPT_TARGETS = [
  { platform: "douyin", label: "抖音/视频号", aspect: "9:16" },
  { platform: "wechat", label: "公众号", aspect: "16:9" },
  { platform: "instagram", label: "Instagram", aspect: "1:1" },
] as const;

type AdaptPlatformChoice = (typeof ADAPT_TARGETS)[number]["platform"];

/** 发布文案（与 workflow-engine PlatformCopy 结构对齐） */
interface PublishCopy {
  title: string;
  body: string;
  tags: string[];
  source: "llm" | "template";
}

/** 归一化重绘区域（0–1，与 repaint 接口对齐） */
interface RepaintRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 标签统一带 # 前缀（模板/模型来源可能不一致） */
function withHashTag(tag: string): string {
  return tag.startsWith("#") ? tag : `#${tag}`;
}

/** 复制文本：优先 Clipboard API，失败回退 textarea + execCommand */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 提示信息配色：错误红（#ff2442 系）、成功绿 */
function messageTone(message: string): string {
  return message.startsWith("⚠") || message.includes("失败") ? "text-seal" : "text-[#5FA36B]";
}

function runStamp(status: string): { text: string; className: string } {
  switch (status) {
    case "awaiting_approval":
      return { text: "待批", className: "stamp text-[#F0B429]" };
    case "succeeded":
      return { text: "已讫", className: "stamp text-[#5FA36B]" };
    case "running":
      return { text: "制中", className: "stamp text-seal animate-pulse" };
    case "queued":
      return { text: "待排", className: "stamp stamp-quiet text-ink-faint" };
    case "failed":
      return { text: "作废", className: "stamp text-seal" };
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
    // 封面生成中加快轮询，其余保持低频刷新
    const timer = setInterval(refresh, detail.coverJobPending ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [active, editingPage, refresh, detail.coverJobPending]);

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

  // 顶栏面包屑：作品标题截断
  const crumbTitle = detail.storyboardTitle ?? detail.input.topic;
  const crumbShort = crumbTitle.length > 14 ? `${crumbTitle.slice(0, 14)}…` : crumbTitle;

  return (
    <>
      {/* 顶栏：面包屑 + 状态章 + 评审/取消按钮组（52px 细栏） */}
      <header className="sticky top-0 z-20 flex h-[52px] items-center gap-3 border-b border-line bg-paper/85 px-5 backdrop-blur-md max-md:px-4">
        <span className="min-w-0 truncate font-mono text-xs tracking-[0.14em] text-ink-soft" title={crumbTitle}>
          作品库 / <b className="font-semibold text-ink">{crumbShort}</b>
        </span>
        <span className={`${stamp.className} shrink-0`}>{stamp.text}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {active ? (
            <button
              className="btn-ghost whitespace-nowrap px-3.5 py-1.5 font-mono text-xs"
              onClick={() => void cancel()}
              disabled={cancelling}
            >
              {cancelling ? "作废中…" : "作废本次运行"}
            </button>
          ) : detail.status === "awaiting_approval" ? (
            <button
              className="btn-ink whitespace-nowrap px-4 py-1.5 font-mono text-xs tracking-[0.15em]"
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
              <button
                className="btn-ink whitespace-nowrap px-4 py-1.5 font-mono text-xs tracking-[0.15em]"
                onClick={exportZip}
                disabled={exporting}
              >
                {exporting ? "装订中…" : "导出 ZIP"}
              </button>
              {detail.reviewStatus !== "approved" && (
                <button
                  className="btn-ghost whitespace-nowrap px-3 py-1.5 font-mono text-xs hover:!border-seal hover:!text-seal"
                  onClick={() => void review("approved")}
                >
                  评审通过
                </button>
              )}
              {detail.reviewStatus !== "rejected" && (
                <button
                  className="btn-ghost whitespace-nowrap px-3 py-1.5 font-mono text-xs"
                  onClick={() => void review("rejected")}
                >
                  评审驳回
                </button>
              )}
            </>
          ) : null}
        </div>
      </header>

      <div className="mx-auto max-w-[1080px] space-y-8 px-[26px] pb-20 pt-8 max-md:px-4">
      {/* 标题 */}
      <section className="rise">
        <p className="kicker">
          RUN · {detail.runId.slice(4, 12)} ·{" "}
          {new Date(detail.createdAt).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
        <h1 className="mt-2 font-display text-2xl font-black leading-snug">
          {detail.storyboardTitle ?? detail.input.topic}
        </h1>
        <p className="mt-2 font-mono text-xs text-ink-soft">
          {detail.input.aspectRatio} · {detail.input.platform} ·{" "}
          {isDeterministic ? "确定性排版" : "原生中文"}
          {detail.concurrency
            ? ` · 并发 ${detail.concurrency.effective}（请求 ${detail.concurrency.requested} / 上限 ${detail.concurrency.serverMax}）`
            : ""}
          {active ? ` · ${readyCount}/${detail.pages.length || "?"}` : ""}
        </p>
        {detail.status === "succeeded" && detail.reviewStatus !== "pending" && (
          <p className="mt-2 font-mono text-[11px] text-ink-faint">
            当前评审：{detail.reviewStatus === "approved" ? "已通过" : "已驳回"}
            {detail.reviewNote ? ` · ${detail.reviewNote}` : ""}
          </p>
        )}
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
          <div className="flex items-center gap-3">
            <span className="kicker">
              {readyCount} 已成{failedCount > 0 ? ` · ${failedCount} 失败` : ""}
              {detail.pages.some((p) => (p.revision ?? 1) > 1) ? " · 含返修版本" : ""}
            </span>
            {detail.status === "succeeded" && isDeterministic && (
              <RerenderAllButton runId={detail.runId} pages={detail.pages} onDone={refresh} />
            )}
          </div>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
          {detail.pages.map((page, index) => (
            <PageFrame
              key={page.index}
              page={page}
              no={index + 1}
              runId={detail.runId}
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

      {/* 封面候选：挑选一张作为作品封面（导出 ZIP 时携带）；漫画以首页为封面 */}
      {detail.status === "succeeded" && (
        <CoverCandidatesCard detail={detail} onDone={refresh} />
      )}

      {/* 发布文案：基于 storyboard，deterministic 与 native 都可展示 */}
      {detail.status === "succeeded" && <PublishCopyCard runId={detail.runId} />}

      {/* 平台适配包：确定性模式零模型费用一键重排其他平台 */}
      {detail.status === "succeeded" && (
        <PlatformAdaptCard runId={detail.runId} isDeterministic={isDeterministic} input={detail.input} />
      )}

      {/* 生成信息（全部参数可追溯） */}
      <section className="rise border-t border-line pt-5" style={{ animationDelay: "180ms" }}>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-display text-lg font-bold">生成信息</h2>
          <span className="kicker">COLOPHON · 全参数可追溯</span>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-0 sm:grid-cols-3">
          <InfoRow label="内容类型" value={RECIPE_LABELS[detail.generation.recipe as Recipe] ?? detail.generation.recipe} />
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
    </>
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
  runId,
  isDeterministic,
  editing,
  onToggleEdit,
  onDone,
}: {
  page: RunDetailPage;
  no: number;
  runId: string;
  isDeterministic: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onDone: () => Promise<void>;
}) {
  // 框选状态放在 PageFrame 层：切换/取消时一并复位
  const [selecting, setSelecting] = useState(false);
  function closeSelecting() {
    setSelecting(false);
  }

  if (page.status === "ready" && page.assetId) {
    const revised = (page.revision ?? 1) > 1;
    return (
      <figure className="photo-frame p-2.5 pb-0">
        <div className={revised ? "" : "frame-ready"}>
          <RegionImage runId={runId} page={page} no={no} selecting={selecting} onCancelSelect={closeSelecting} onDone={onDone} />
        </div>
        <figcaption className="flex items-center justify-between px-1 py-2.5">
          <span className="font-mono text-[10px] text-ink-faint" title={page.model ? `生成模型：${page.model}` : undefined}>
            图{String(no).padStart(2, "0")} · {page.role}
            {revised ? ` · 第${page.revision}版` : ""}
            {page.model ? ` · ${page.model}` : ""}
            {page.layout && page.layout !== "default" && LAYOUT_LABELS[page.layout] && (
              <span className="ml-1 rounded bg-seal px-1.5 py-0.5 text-[9px] tracking-wider text-white">
                {LAYOUT_LABELS[page.layout]}
              </span>
            )}
          </span>
          <span className="truncate px-2 text-xs text-ink-soft">{page.headline}</span>
          <span className="flex shrink-0 items-center gap-1">
            <button
              className="btn-ghost px-2 py-0.5 font-mono text-[10px] hover:!border-seal hover:!text-seal"
              onClick={() => setSelecting((prev) => !prev)}
              title="框选画面区域做局部重绘（需要支持图生图的渠道）"
            >
              {selecting ? "取消框选" : "区域重绘"}
            </button>
            <button className="btn-ghost shrink-0 px-2 py-0.5 font-mono text-[10px]" onClick={onToggleEdit}>
              {editing ? "收起" : "返修"}
            </button>
          </span>
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
        <span className="stamp text-seal line-through">作废</span>
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

/**
 * 区域重绘：页面图片上叠加遮罩，mousedown 拖动画出归一化矩形，
 * 松开后输入描述 → POST repaint（同步等待，最长 120s）。
 * 切换模式 / 取消时由 selecting 变化统一复位。
 */
function RegionImage({
  runId,
  page,
  no,
  selecting,
  onCancelSelect,
  onDone,
}: {
  runId: string;
  page: RunDetailPage;
  no: number;
  selecting: boolean;
  onCancelSelect: () => void;
  onDone: () => Promise<void>;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<RepaintRect | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 进入/退出框选模式时清理框选与输入状态
  useEffect(() => {
    setDragStart(null);
    setRect(null);
    setPrompt("");
    setMessage(null);
  }, [selecting]);

  /** 客户端坐标 → 图片容器内归一化坐标（0–1） */
  function pointFrom(clientX: number, clientY: number): { x: number; y: number } | null {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (clientY - box.top) / box.height)),
    };
  }

  function handleMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (!selecting || busy || event.button !== 0) return;
    event.preventDefault();
    const point = pointFrom(event.clientX, event.clientY);
    if (!point) return;
    setDragStart(point);
    setRect({ x: point.x, y: point.y, w: 0, h: 0 });
  }

  function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    if (!dragStart || busy) return;
    const point = pointFrom(event.clientX, event.clientY);
    if (!point) return;
    setRect({
      x: Math.min(dragStart.x, point.x),
      y: Math.min(dragStart.y, point.y),
      w: Math.abs(point.x - dragStart.x),
      h: Math.abs(point.y - dragStart.y),
    });
  }

  function handleMouseUp() {
    if (!dragStart || busy) return;
    setDragStart(null);
    // 拖动太小视为误触，丢弃矩形
    if (rect && (rect.w < 0.02 || rect.h < 0.02)) setRect(null);
  }

  function handleMouseLeave() {
    if (dragStart && !busy) {
      setDragStart(null);
      setRect(null);
    }
  }

  async function submitRepaint() {
    if (!rect || busy || !prompt.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/runs/${runId}/pages/${page.index}/repaint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rect, prompt: prompt.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      onCancelSelect();
      await onDone();
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : caught}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div ref={frameRef} className="relative">
        <img
          src={`/api/assets/${page.assetId}`}
          alt={`第 ${no} 页：${page.headline}`}
          className={`w-full border border-line/60 ${selecting ? "pointer-events-none select-none" : ""}`}
          draggable={false}
        />
        {selecting && (
          <div
            className="absolute inset-0 cursor-crosshair bg-ink/20"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
          >
            {rect && rect.w > 0 && rect.h > 0 && (
              <div
                className="absolute border-2 border-seal bg-seal/25"
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                }}
              />
            )}
            {dragStart && rect && (
              <span className="absolute left-1 top-1 bg-paper/90 px-1.5 py-0.5 font-mono text-[10px] text-ink">
                x {(rect.x * 100).toFixed(0)}% · y {(rect.y * 100).toFixed(0)}% · 宽 {(rect.w * 100).toFixed(0)}% · 高{" "}
                {(rect.h * 100).toFixed(0)}%
              </span>
            )}
          </div>
        )}
      </div>
      {selecting && rect && !dragStart && (
        <div className="border-t border-line bg-paper-deep p-3">
          <span className="field-label">第 {no} 页 · 区域重绘</span>
          <input
            className="field-input mt-1 !text-sm"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="区域内改成什么，例如：把背景换成黄昏色调"
            disabled={busy}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              className="btn-ink px-3 py-1.5 font-mono text-[11px]"
              onClick={() => void submitRepaint()}
              disabled={busy || !prompt.trim()}
              title="调用支持图生图的渠道执行局部重绘，会产生一次图片调用费用"
            >
              {busy ? "AI 重绘中（约 1–2 分钟）" : "确认重绘"}
            </button>
            <button className="btn-ghost px-3 py-1.5 font-mono text-[11px]" onClick={() => setRect(null)} disabled={busy}>
              重选
            </button>
            <button className="btn-ghost px-3 py-1.5 font-mono text-[11px]" onClick={onCancelSelect} disabled={busy}>
              取消
            </button>
          </div>
          {message && <p className={`mt-2 font-mono text-[10px] ${messageTone(message)}`}>{message}</p>}
        </div>
      )}
      {selecting && !rect && !dragStart && !busy && (
        <p className="border-t border-line bg-paper-deep px-3 py-2 font-mono text-[10px] text-ink-soft">
          在图上按住鼠标拖出要重绘的区域。
        </p>
      )}
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
    <div className="border-t border-line bg-paper-deep p-3">
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
      {message && <p className={`mt-2 font-mono text-[10px] ${messageTone(message)}`}>{message}</p>}
    </div>
  );
}

/**
 * 封面候选卡片：每个作品产出 3 个封面候选（不同标题钩子/构图），
 * 用户挑选一张作为作品封面（导出 ZIP 时作为首张 00-封面.png）。
 * 漫画类型不做封面候选（漫画首页即封面）。
 */
function CoverCandidatesCard({ detail, onDone }: { detail: RunDetailPayload; onDone: () => Promise<void> }) {
  const recipe = detail.generation.recipe;
  const isComic = recipe === "comic_story" || recipe === "strip_comic";
  const [generating, setGenerating] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (isComic) {
    return (
      <section className="rise" style={{ animationDelay: "130ms" }}>
        <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-lg font-bold">封面候选</h2>
          <span className="kicker">COVER · 作品封面</span>
        </div>
        <div className="border border-line bg-paper-deep px-5 py-4">
          <p className="font-mono text-[11px] text-ink-soft">漫画以首页为封面，无需单独挑选。</p>
        </div>
      </section>
    );
  }

  async function generate() {
    if (generating) return;
    setGenerating(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/runs/${detail.runId}/covers/generate`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { error?: string; hint?: string };
      if (!response.ok) {
        throw new Error(body.hint ?? body.error ?? `HTTP ${response.status}`);
      }
      setMessage(body.hint ?? "封面生成中，约 1–2 分钟，稍后刷新查看");
      await onDone();
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : caught}`);
    } finally {
      setGenerating(false);
    }
  }

  async function select(assetId: string) {
    if (selecting) return;
    setSelecting(assetId);
    setMessage(null);
    try {
      const response = await fetch(`/api/runs/${detail.runId}/cover/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assetId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      await onDone();
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : caught}`);
    } finally {
      setSelecting(null);
    }
  }

  const pending = detail.coverJobPending;

  return (
    <section className="rise" style={{ animationDelay: "130ms" }}>
      <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
        <h2 className="font-display text-lg font-bold">封面候选</h2>
        <span className="kicker">COVER · 3 选 1 · 随 ZIP 导出</span>
      </div>
      <div className="border border-line bg-paper-deep p-5">
        {detail.covers.length > 0 ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            {detail.covers.map((cover) => {
              const selected = detail.selectedCoverAssetId === cover.assetId;
              const tooLong = cover.hookTitle.length > 12;
              return (
                <figure
                  key={cover.assetId}
                  className={`photo-frame p-2.5 pb-0 ${selected ? "!border-seal shadow-[0_0_14px_rgba(255,36,66,0.18)]" : ""}`}
                >
                  <div className="relative">
                    <img
                      src={`/api/assets/${cover.assetId}`}
                      alt={`封面候选 ${cover.variant}：${cover.hookTitle}`}
                      className="w-full border border-line/60"
                      draggable={false}
                    />
                    {selected && (
                      <span className="absolute left-1.5 top-1.5 rounded bg-seal px-2 py-0.5 font-mono text-[10px] font-semibold text-white">
                        当前封面 ✓
                      </span>
                    )}
                    <span className="absolute right-1.5 top-1.5 bg-paper/90 px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
                      候选 {cover.variant}
                    </span>
                  </div>
                  <figcaption className="px-1 py-2.5">
                    <p className="truncate font-display text-sm font-bold" title={cover.hookTitle}>
                      {cover.hookTitle}
                    </p>
                    {tooLong && <p className="mt-0.5 font-mono text-[10px] text-[#F0B429]">标题偏长，建议 ≤12 字</p>}
                    <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint" title={cover.styleNote}>
                      {cover.styleNote}
                    </p>
                    <div className="mt-2">
                      {selected ? (
                        <span className="stamp stamp-quiet text-ink-faint">已选用</span>
                      ) : (
                        <button
                          className="btn-ghost px-3 py-1 font-mono text-[11px] hover:!border-seal hover:!text-seal"
                          onClick={() => void select(cover.assetId)}
                          disabled={selecting !== null}
                        >
                          {selecting === cover.assetId ? "选定中…" : "选为封面"}
                        </button>
                      )}
                    </div>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        ) : pending || generating ? (
          <p className="font-mono text-[11px] text-seal">封面生成中…（约 1–2 分钟，生成完成后自动展示）</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="btn-ink px-4 py-2 font-mono text-xs tracking-[0.1em]"
              onClick={() => void generate()}
              disabled={generating}
              title="生成 3 个封面候选（不同标题钩子/构图），约消耗 3 次图片额度"
            >
              {generating ? "提交中…" : "生成封面候选（3 张，约消耗 3 次图片额度）"}
            </button>
            <span className="font-mono text-[10px] text-ink-faint">挑选一张作为作品封面，导出 ZIP 时一并携带。</span>
          </div>
        )}
        {message && <p className={`mt-3 font-mono text-[11px] ${messageTone(message)}`}>{message}</p>}
      </div>
    </section>
  );
}

/**
 * 发布文案卡片：标题 / 正文 / 标签，一键复制与 AI 润色。
 * 文案基于 storyboard（与图无关），deterministic 与 native 都显示。
 */
function PublishCopyCard({ runId }: { runId: string }) {
  const [copy, setCopy] = useState<PublishCopy | null>(null);
  const [loading, setLoading] = useState(true);
  const [polishing, setPolishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const response = await fetch(`/api/runs/${runId}/copy`, { cache: "no-store" });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        if (alive) setCopy((await response.json()) as PublishCopy);
      } catch (caught) {
        if (alive) setMessage(`⚠ ${caught instanceof Error ? caught.message : caught}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [runId]);

  /** AI 润色：?mode=llm，后端 20s 超时或无模型时自动降级模板（source 标注） */
  async function polish() {
    if (polishing) return;
    setPolishing(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/runs/${runId}/copy?mode=llm`, { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      setCopy((await response.json()) as PublishCopy);
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : caught}`);
    } finally {
      setPolishing(false);
    }
  }

  /** 复制全部：标题 + 空行 + 正文 + 空行 + #tag… */
  async function copyAll() {
    if (!copy || copied) return;
    const text = [copy.title, "", copy.body, "", copy.tags.map(withHashTag).join(" ")].join("\n");
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setMessage("复制失败，请手动选择文本复制。");
    }
  }

  return (
    <section className="rise" style={{ animationDelay: "140ms" }}>
      <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
        <h2 className="font-display text-lg font-bold">发布文案</h2>
        <span className="kicker">COPY · 标题 / 正文 / 标签</span>
      </div>
      <div className="border border-line bg-paper-deep p-5">
        {loading ? (
          <p className="font-mono text-[11px] text-ink-faint">文案生成中…</p>
        ) : copy ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <h3 className="font-display text-xl font-black leading-snug text-ink sm:text-2xl">{copy.title}</h3>
              <span className="stamp stamp-quiet shrink-0 text-ink-faint">
                {copy.source === "llm" ? "AI" : "模板"}
              </span>
            </div>
            <p className="mt-3 whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-ink">{copy.body}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {copy.tags.map((tag) => (
                <span key={tag} className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[11px] text-ink-soft">
                  {withHashTag(tag)}
                </span>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button className="btn-ink px-4 py-1.5 font-mono text-[11px] tracking-[0.1em]" onClick={() => void copyAll()}>
                {copied ? "已复制 ✓" : "一键复制全部"}
              </button>
              <button
                className="btn-ghost px-4 py-1.5 font-mono text-[11px] hover:!border-seal hover:!text-seal"
                onClick={() => void polish()}
                disabled={polishing}
                title="用文本模型重新生成发布文案；无可用模型或超时时自动回退模板"
              >
                {polishing ? "润色中…约 10-20 秒" : "AI 润色"}
              </button>
              {message && <span className={`font-mono text-[11px] ${messageTone(message)}`}>{message}</span>}
            </div>
          </>
        ) : (
          <p className="font-mono text-[11px] text-ink-faint">{message ?? "暂无文案。"}</p>
        )}
      </div>
    </section>
  );
}

/**
 * 按当前品牌重排全部页（deterministic 专属）：
 * 逐页调用 rerender（零模型费用），headline/body 取详情数据里该页现值。
 */
function RerenderAllButton({
  runId,
  pages,
  onDone,
}: {
  runId: string;
  pages: RunDetailPage[];
  onDone: () => Promise<void>;
}) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const readyPages = pages.filter((page) => page.status === "ready" && page.assetId);

  async function rerenderAll() {
    if (progress) return;
    const total = readyPages.length;
    if (total === 0) {
      setMessage("没有可重排的页面。");
      return;
    }
    if (!window.confirm(`将逐页重新排版（零生成费用，耗时约 ${total * 2} 秒）。继续？`)) return;
    setMessage(null);
    setProgress({ done: 0, total });
    for (let i = 0; i < readyPages.length; i++) {
      const page = readyPages[i]!;
      try {
        const response = await fetch(`/api/runs/${runId}/pages/${page.index}/rerender`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            headline: page.headline,
            body: (page.expectedCopy ?? []).slice(1).map((line) => line.trim()).filter(Boolean),
          }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
      } catch (caught) {
        setMessage(
          `第 ${i + 1} 页失败：${caught instanceof Error ? caught.message : caught}，已完成 ${i}/${total}`,
        );
        setProgress(null);
        await onDone();
        return;
      }
      setProgress({ done: i + 1, total });
    }
    setProgress(null);
    setMessage(`已按当前品牌重排全部 ${total} 页。`);
    await onDone();
  }

  if (readyPages.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        className="btn-ghost px-3 py-1 font-mono text-[11px]"
        onClick={() => void rerenderAll()}
        disabled={Boolean(progress)}
        title="只重排文字版式，沿用现有视觉层，零模型费用"
      >
        {progress ? `重排中 ${progress.done}/${progress.total}…` : "按品牌重排全部页"}
      </button>
      {message && <span className={`font-mono text-[10px] ${messageTone(message)}`}>{message}</span>}
    </span>
  );
}

/**
 * 平台适配包卡片：已完成作品一键导出其他平台规格。
 * deterministic 模式 → POST /api/runs/:id/adapt 零模型费用重排并下载 ZIP；
 * native 模式 → 以目标比例创建新 run 重新生成（消耗生成额度）。
 */
function PlatformAdaptCard({
  runId,
  isDeterministic,
  input,
}: {
  runId: string;
  isDeterministic: boolean;
  input: RunDetailPayload["input"];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  /** 适配包下载：响应为 ZIP 流，x-adapt-missing-pages 头携带被跳过的页 */
  async function adapt(platform: AdaptPlatformChoice) {
    if (busy) return;
    setBusy(platform);
    setMessage(null);
    try {
      const response = await fetch(`/api/runs/${runId}/adapt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string; hint?: string };
        throw new Error(body.hint ?? body.error ?? `HTTP ${response.status}`);
      }
      const missing = (response.headers.get("x-adapt-missing-pages") ?? "")
        .split(",")
        .filter(Boolean)
        .map((s) => Number(s) + 1);
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `adapt-${platform}.zip`;
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setMessage(missing.length > 0 ? `已下载；第 ${missing.join("、")} 页缺视觉层已跳过。` : "适配包已下载。");
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : caught}`);
    } finally {
      setBusy(null);
    }
  }

  /** native 模式：读取当前 run input，改比例后创建新 run 重新生成 */
  async function regenerateAs(target: (typeof ADAPT_TARGETS)[number]) {
    if (busy) return;
    if (!window.confirm(`将以 ${target.aspect}（${target.label}）重新生成整套作品，将消耗生成额度。继续？`)) return;
    setBusy(target.platform);
    setMessage(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, aspectRatio: target.aspect }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const { runId: newRunId } = (await response.json()) as { runId: string };
      router.push(`/runs/${newRunId}`);
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : caught}`);
      setBusy(null);
    }
  }

  return (
    <section className="rise" style={{ animationDelay: "150ms" }}>
      <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
        <h2 className="font-display text-lg font-bold">平台适配包</h2>
        <span className="kicker">ADAPT · 一次创作 · 多平台分发</span>
      </div>
      <div className="border border-line bg-paper-deep p-5">
        {isDeterministic ? (
          <>
            <p className="font-mono text-[11px] text-ink-soft">
              确定性模式：按目标平台比例重新排版，沿用模型视觉层，零模型费用，不改动原作资产。
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {ADAPT_TARGETS.map((target) => (
                <div key={target.platform} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-paper-card px-4 py-3">
                  <div>
                    <p className="text-sm font-bold">{target.label}</p>
                    <p className="font-mono text-[10px] text-ink-faint">{target.aspect}</p>
                  </div>
                  <button
                    className="btn-ghost shrink-0 px-3 py-1.5 font-mono text-[11px] hover:!border-seal hover:!text-seal"
                    onClick={() => void adapt(target.platform)}
                    disabled={Boolean(busy)}
                  >
                    {busy === target.platform ? "排版中…" : "生成并下载"}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="font-mono text-[11px] text-ink-soft">
              原生中文模式的画面已含文字，无法免费重排；可按目标比例重新生成整套作品（消耗生成额度）。
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {ADAPT_TARGETS.map((target) => (
                <div key={target.platform} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-paper-card px-4 py-3">
                  <div>
                    <p className="text-sm font-bold">{target.label}</p>
                    <p className="font-mono text-[10px] text-ink-faint">以 {target.aspect} 重新生成</p>
                  </div>
                  <button
                    className="btn-ghost shrink-0 px-3 py-1.5 font-mono text-[11px]"
                    onClick={() => void regenerateAs(target)}
                    disabled={Boolean(busy)}
                    title={`复制当前参数，以 ${target.aspect} 创建新运行`}
                  >
                    {busy === target.platform ? "创建中…" : `以 ${target.aspect} 重新生成`}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        {message && <p className={`mt-3 font-mono text-[11px] ${messageTone(message)}`}>{message}</p>}
      </div>
    </section>
  );
}
