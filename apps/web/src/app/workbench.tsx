"use client";

import { useEffect, useState } from "react";
import { TextRenderingModeSchema } from "@aai/shared-schemas";
import type { BrandKitView, RunListItem, RunsListPayload } from "@/lib/types";

interface Props {
  initial: RunsListPayload;
  brandKits: BrandKitView[];
}

/** 编辑部状态章：状态 → 章文与色 */
export function statusStamp(status: string): { text: string; className: string } {
  switch (status) {
    case "succeeded":
      return { text: "已讫", className: "stamp text-seal" };
    case "running":
      return { text: "制中", className: "stamp text-seal animate-pulse" };
    case "queued":
      return { text: "待排", className: "stamp stamp-quiet text-ink-faint" };
    case "failed":
      return { text: "作废", className: "stamp text-ink line-through decoration-1" };
    case "cancelled":
      return { text: "已废", className: "stamp stamp-quiet text-ink-faint" };
    default:
      return { text: status, className: "stamp stamp-quiet text-ink-faint" };
  }
}

const reviewLabel: Record<string, string> = { pending: "待审", approved: "过审", rejected: "驳回" };

export function Workbench({ initial, brandKits }: Props) {
  const [data, setData] = useState<RunsListPayload>(initial);
  const [topic, setTopic] = useState("");
  const [aspectRatio, setAspectRatio] = useState("3:4");
  const [mode, setMode] = useState<string>("native");
  const [concurrency, setConcurrency] = useState<number>(initial.defaultConcurrency);
  const [sourceText, setSourceText] = useState("");
  const [brandKitId, setBrandKitId] = useState("");
  const [recipe, setRecipe] = useState<"knowledge_cards" | "comic_story">("knowledge_cards");
  const [castDescription, setCastDescription] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [urlImporting, setUrlImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requireApproval, setRequireApproval] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<"all" | "pending" | "approved" | "rejected">("all");

  useEffect(() => {
    const active = data.runs.some((run) => run.status === "running" || run.status === "queued");
    const timer = setInterval(
      async () => {
        try {
          const response = await fetch("/api/runs", { cache: "no-store" });
          if (response.ok) setData((await response.json()) as RunsListPayload);
        } catch {
          /* 下一轮再取 */
        }
      },
      active ? 3000 : 15000,
    );
    return () => clearInterval(timer);
  }, [data.runs]);

  async function importUrl() {
    if (!url.trim() || urlImporting) return;
    setUrlImporting(true);
    setError(null);
    try {
      const response = await fetch("/api/fetch-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const result = (await response.json()) as { title?: string; text?: string; error?: string };
      if (!response.ok || !result.text) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSourceText(`${result.title ? `【${result.title}】\n` : ""}${result.text}`.slice(0, 20000));
      setNotice(`已导入「${result.title || url}」正文，可编辑后生成。`);
    } catch (caught) {
      setError(`URL 抓取失败（${caught instanceof Error ? caught.message : caught}），可直接粘贴正文。`);
    } finally {
      setUrlImporting(false);
    }
  }

  async function submit() {
    if (!topic.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipe,
          topic: topic.trim(),
          aspectRatio,
          textRenderingMode: TextRenderingModeSchema.parse(mode),
          requestedImageConcurrency: concurrency,
          ...(recipe === "comic_story" && castDescription.trim()
            ? { castDescription: castDescription.trim().slice(0, 2000) }
            : {}),
          ...(recipe !== "comic_story" && sourceText.trim()
            ? { sourceText: sourceText.trim().slice(0, 20000) }
            : {}),
          ...(brandKitId ? { brandKitId } : {}),
          requireApproval,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const created = (await response.json()) as { runId: string };
      window.location.assign(`/runs/${created.runId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSubmitting(false);
    }
  }

  const filteredRuns =
    reviewFilter === "all" ? data.runs : data.runs.filter((run) => run.reviewStatus === reviewFilter);

  return (
    <div className="pb-56">
      {/* 刊首 */}
      <section className="rise pt-10">
        <p className="kicker">
          VOL.01 · {new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" })} ·{" "}
          {data.providerMode === "real" ? "真实渠道" : data.providerMode === "partial" ? "部分真实渠道" : "演示渠道"}
        </p>
        <h1 className="mt-3 font-display text-3xl font-black sm:text-4xl">
          作品集<span className="text-seal">。</span>
        </h1>
      </section>

      {/* 运行卡片网格 */}
      <section className="rise mt-8" style={{ animationDelay: "80ms" }}>
        <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-lg font-bold">最近运行</h2>
          <div className="flex items-center gap-1">
            {(["all", "pending", "approved", "rejected"] as const).map((value) => (
              <button
                key={value}
                className={`px-2.5 py-1 font-mono text-[11px] transition-colors ${
                  reviewFilter === value ? "bg-ink text-paper" : "text-ink-soft hover:text-ink"
                }`}
                onClick={() => setReviewFilter(value)}
              >
                {value === "all" ? "全部" : reviewLabel[value]}
              </button>
            ))}
          </div>
        </div>
        {filteredRuns.length === 0 ? (
          <p className="border border-dashed border-line-dark px-6 py-14 text-center text-sm text-ink-faint">
            {data.runs.length === 0 ? "版面还是空的 —— 在下方写下第一个主题。" : "该评审状态下暂无运行。"}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-6 md:grid-cols-3">
            {filteredRuns.map((run) => (
              <RunCard key={run.runId} run={run} />
            ))}
          </div>
        )}
      </section>

      {/* 底部悬浮创作条 */}
      <div className="fixed inset-x-0 bottom-0 z-40">
        <div className="mx-auto max-w-5xl px-4 pb-4">
          <div className="photo-frame border-2 border-ink p-4 shadow-[0_-8px_40px_-12px_rgba(28,24,20,0.35)]">
            {error && <p className="mb-2 font-mono text-xs text-seal">⚠ {error}</p>}
            {notice && <p className="mb-2 font-mono text-xs text-ink-soft">✓ {notice}</p>}
            <div className="flex items-center gap-3">
              <input
                id="topic"
                className="field-input !border-b-0 font-display !text-lg"
                placeholder={
                  recipe === "comic_story" ? "漫画主题，例如：为什么会晕车" : "主题，例如：三分钟看懂量子纠缠"
                }
                value={topic}
                maxLength={120}
                onChange={(event) => setTopic(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
              <button
                className="btn-ink shrink-0 px-6 py-2.5 font-mono text-sm tracking-[0.15em]"
                onClick={() => void submit()}
                disabled={submitting || !topic.trim()}
              >
                {submitting ? "排字中…" : "开始创作"}
              </button>
              <button
                className="btn-ghost shrink-0 px-3 py-2.5 font-mono text-sm"
                onClick={() => setMoreOpen(!moreOpen)}
                title="更多输入与参数"
              >
                {moreOpen ? "收起 ▾" : "展开 ▸"}
              </button>
            </div>

            {moreOpen && (
              <div className="mt-4 space-y-4 border-t border-line pt-4">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                  <div>
                    <span className="field-label">内容类型</span>
                    <select
                      className="field-input mt-1 !py-1.5 !text-[13px]"
                      value={recipe}
                      onChange={(event) => setRecipe(event.target.value as "knowledge_cards" | "comic_story")}
                    >
                      <option value="knowledge_cards">知识卡片</option>
                      <option value="comic_story">科普漫画</option>
                    </select>
                  </div>
                  <div>
                    <span className="field-label">文字模式</span>
                    <select
                      className="field-input mt-1 !py-1.5 !text-[13px]"
                      value={mode}
                      onChange={(event) => setMode(event.target.value)}
                    >
                      <option value="native">原生中文</option>
                      <option value="deterministic">确定性排版</option>
                    </select>
                  </div>
                  <div>
                    <span className="field-label">比例</span>
                    <select
                      className="field-input mt-1 !py-1.5 !text-[13px]"
                      value={aspectRatio}
                      onChange={(event) => setAspectRatio(event.target.value)}
                    >
                      <option value="3:4">3:4</option>
                      <option value="9:16">9:16</option>
                      <option value="1:1">1:1</option>
                      <option value="16:9">16:9</option>
                    </select>
                  </div>
                  <div>
                    <span className="field-label">并发</span>
                    <select
                      className="field-input mt-1 !py-1.5 !text-[13px]"
                      value={concurrency}
                      onChange={(event) => setConcurrency(Number(event.target.value))}
                    >
                      {Array.from({ length: initial.serverMaxConcurrency }, (_, index) => index + 1).map((value) => (
                        <option key={value} value={value}>
                          {value} 路
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <span className="field-label">品牌手册</span>
                    <select
                      className="field-input mt-1 !py-1.5 !text-[13px]"
                      value={brandKitId}
                      onChange={(event) => setBrandKitId(event.target.value)}
                    >
                      <option value="">不使用</option>
                      {brandKits.map((kit) => (
                        <option key={kit.id} value={kit.id}>
                          {kit.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {recipe === "comic_story" && (
                  <div>
                    <span className="field-label">主角设定（可选）</span>
                    <textarea
                      className="field-input mt-1 min-h-[48px] resize-y font-mono !text-[12px]"
                      placeholder="例如：科普向导少女「阿晕」，扎双马尾，戴圆框眼镜，穿薄荷绿实验服"
                      value={castDescription}
                      maxLength={2000}
                      onChange={(event) => setCastDescription(event.target.value)}
                    />
                  </div>
                )}

                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={requireApproval}
                    onChange={(event) => setRequireApproval(event.target.checked)}
                    className="accent-[#b5382d]"
                  />
                  完成后需人工确认终稿（审批门：确认前不可导出）
                </label>

                {recipe !== "comic_story" && (
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="field-label">参考资料（可选 · 长文按要点密度拆为 6–10 页）</span>
                      <span className="font-mono text-[10px] text-ink-faint">{sourceText.length}/20000</span>
                    </div>
                    <textarea
                      className="field-input mt-1 min-h-[48px] resize-y font-mono !text-[12px]"
                      placeholder="粘贴文章 / Markdown / 资料正文"
                      value={sourceText}
                      maxLength={20000}
                      onChange={(event) => setSourceText(event.target.value)}
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        className="field-input !py-1 font-mono !text-xs"
                        placeholder="https://example.com/article（实验能力）"
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                      />
                      <button
                        className="btn-ghost shrink-0 px-3 py-1 font-mono text-[11px]"
                        onClick={() => void importUrl()}
                        disabled={urlImporting || !url.trim()}
                      >
                        {urlImporting ? "抓取中…" : "从 URL 导入"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunCard({ run }: { run: RunListItem }) {
  const stamp = statusStamp(run.status);
  const date = new Date(run.createdAt).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <button
      className="photo-frame group relative overflow-hidden p-2.5 pb-0 text-left transition-transform hover:-translate-y-0.5"
      onClick={() => window.location.assign(`/runs/${run.runId}`)}
    >
      {/* 封面 */}
      <div className="relative aspect-[3/4] overflow-hidden border border-line/60 bg-paper-deep">
        {run.coverAssetId ? (
          <img
            src={`/api/assets/${run.coverAssetId}`}
            alt={`《${run.topic}》封面`}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2">
            <span className="font-display text-4xl font-black text-ink-faint/30">印</span>
            <span className="font-mono text-[10px] tracking-[0.3em] text-ink-faint">
              {run.status === "running" ? "制中…" : "待排"}
            </span>
          </div>
        )}
        <span className={`absolute right-2 top-2 bg-paper/80 px-1 text-[11px] ${stamp.className}`}>{stamp.text}</span>
      </div>
      {/* 文字区 */}
      <div className="px-1 pb-2.5 pt-2.5">
        <p className="truncate font-display text-base font-semibold">{run.topic}</p>
        <p className="mt-1 font-mono text-[10px] text-ink-faint">
          {run.pageCount > 0 ? `${run.pageCount} 页` : "—"} · {run.mode === "native" ? "原生" : "确定性"} · {date}
          {run.status === "succeeded" ? ` · ${reviewLabel[run.reviewStatus]}` : ""}
        </p>
      </div>
    </button>
  );
}
