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
  const [urlImporting, setUrlImporting] = useState(false);
  const [url, setUrl] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setNotice(null);
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
      // 实验能力：失败降级为手动粘贴正文
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
          ...(recipe === "comic_story" && castDescription.trim() ? { castDescription: castDescription.trim().slice(0, 2000) } : {}),
          ...(recipe !== "comic_story" && sourceText.trim() ? { sourceText: sourceText.trim().slice(0, 20000) } : {}),
          ...(brandKitId ? { brandKitId } : {}),
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
    <div className="space-y-16">
      {/* 刊首 */}
      <section className="rise pt-12">
        <p className="kicker">
          VOL.01 · {new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" })} ·{" "}
          {data.providerMode === "real" ? "真实渠道" : data.providerMode === "partial" ? "部分真实渠道" : "演示渠道"}
        </p>
        <h1 className="mt-4 font-display text-4xl font-black leading-snug sm:text-[44px]">
          把一句话，变成一套
          <br />
          可发布的图文<span className="text-seal">。</span>
        </h1>
        <p className="mt-4 max-w-lg text-sm leading-relaxed text-ink-soft">
          输入主题或长文，生成结构化文案与整页图片；中文逐字可查，全程可追溯、可返修、可导出。
        </p>
      </section>

      {/* 创作表单 */}
      <section className="rise" style={{ animationDelay: "80ms" }}>
        <div className="rule-double mb-6 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-lg font-bold">No.壹 · 创作</h2>
          <span className="kicker">NEW RUN</span>
        </div>
        <label className="field-label" htmlFor="topic">
          主题
        </label>
        <div className="mt-2 flex flex-col gap-5 sm:flex-row sm:items-end">
          <input
            id="topic"
            className="field-input font-display !text-2xl sm:!text-[28px] flex-1"
            placeholder="三分钟看懂量子纠缠"
            value={topic}
            maxLength={120}
            onChange={(event) => setTopic(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          <button
            className="btn-ink px-8 py-3 font-mono text-sm tracking-[0.2em]"
            onClick={() => void submit()}
            disabled={submitting || !topic.trim()}
          >
            {submitting ? "排字中…" : "开始生成"}
          </button>
        </div>
        {error && <p className="mt-3 font-mono text-xs text-seal">⚠ {error}</p>}
        {notice && <p className="mt-3 font-mono text-xs text-ink-soft">✓ {notice}</p>}

        <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
          <div>
            <span className="field-label">内容类型</span>
            <select
              className="field-input mt-1"
              value={recipe}
              onChange={(event) => setRecipe(event.target.value as "knowledge_cards" | "comic_story")}
            >
              <option value="knowledge_cards">知识卡片</option>
              <option value="comic_story">科普漫画</option>
            </select>
          </div>
          <div>
            <span className="field-label">比例 · 平台</span>
            <select className="field-input mt-1" value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
              <option value="3:4">3:4 · 小红书</option>
              <option value="9:16">9:16 · 抖音图文</option>
              <option value="1:1">1:1 · 方图</option>
              <option value="16:9">16:9 · 公众号配图</option>
            </select>
          </div>
          <div>
            <span className="field-label">文字模式</span>
            <select className="field-input mt-1" value={mode} onChange={(event) => setMode(event.target.value)}>
              <option value="native">原生中文（默认）</option>
              <option value="deterministic">确定性排版（兜底）</option>
            </select>
          </div>
          <div>
            <span className="field-label">图片并发</span>
            <select
              className="field-input mt-1"
              value={concurrency}
              onChange={(event) => setConcurrency(Number(event.target.value))}
            >
              {Array.from({ length: initial.serverMaxConcurrency }, (_, index) => index + 1).map((value) => (
                <option key={value} value={value}>
                  {value} 路{value === initial.serverMaxConcurrency ? "（上限）" : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="field-label">品牌手册</span>
            <select className="field-input mt-1" value={brandKitId} onChange={(event) => setBrandKitId(event.target.value)}>
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
          <div className="mt-8">
            <span className="field-label">主角设定（可选 · 空缺时自动设计科普向导角色）</span>
            <textarea
              className="field-input mt-1 min-h-[56px] resize-y !text-[13px] leading-relaxed"
              placeholder="例如：圆脸短发少女「阿科」，戴红色贝雷帽和圆框眼镜，穿白色实验服，背一个黄铜色小背包"
              value={castDescription}
              maxLength={2000}
              onChange={(event) => setCastDescription(event.target.value)}
            />
            <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
              科普漫画流程：角色锚点与定妆图 → 分镜（对白归属一致性检查）→ 逐页生成（渠道支持图生图时引用定妆图保持角色一致）→ 对白气泡程序渲染。3–6 页。
            </p>
          </div>
        )}

        {/* 参考资料：长文 / URL 导入（密度拆页） */}
        {recipe !== "comic_story" && (
        <div className="mt-8">
          <div className="flex items-baseline justify-between">
            <span className="field-label">参考资料（可选 · 粘贴长文将按要点密度拆为 6–10 页）</span>
            <span className="font-mono text-[10px] text-ink-faint">{sourceText.length}/20000</span>
          </div>
          <textarea
            className="field-input mt-1 min-h-[72px] resize-y font-mono !text-[12px] leading-relaxed"
            placeholder="粘贴文章 / Markdown / 资料正文；或从 URL 导入"
            value={sourceText}
            maxLength={20000}
            onChange={(event) => setSourceText(event.target.value)}
          />
          <div className="mt-2 flex items-center gap-2">
            <input
              className="field-input !py-1.5 font-mono !text-xs"
              placeholder="https://example.com/article（实验能力）"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <button className="btn-ghost shrink-0 px-3 py-1.5 font-mono text-xs" onClick={() => void importUrl()} disabled={urlImporting || !url.trim()}>
              {urlImporting ? "抓取中…" : "从 URL 导入"}
            </button>
          </div>
        </div>
        )}
      </section>

      {/* 运行目录 */}
      <section className="rise" style={{ animationDelay: "160ms" }}>
        <div className="rule-double mb-2 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-lg font-bold">No.贰 · 最近运行</h2>
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
          <p className="border border-dashed border-line-dark px-6 py-12 text-center text-sm text-ink-faint">
            {data.runs.length === 0 ? "目录还是空的 —— 写下第一个主题。" : "该评审状态下暂无运行。"}
          </p>
        ) : (
          <ul>
            {filteredRuns.map((run, index) => (
              <RunRow key={run.runId} run={run} index={index} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RunRow({ run, index }: { run: RunListItem; index: number }) {
  const stamp = statusStamp(run.status);
  const date = new Date(run.createdAt).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <li>
      <button
        className="index-row group flex w-full items-center gap-4 px-3 py-4 text-left"
        onClick={() => window.location.assign(`/runs/${run.runId}`)}
      >
        <span className="w-8 font-mono text-[11px] text-ink-faint">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span className="font-display flex-1 truncate text-base font-semibold">{run.topic}</span>
        {run.status === "succeeded" && (
          <span
            className={`font-mono text-[10px] ${
              run.reviewStatus === "approved"
                ? "text-seal"
                : run.reviewStatus === "rejected"
                  ? "text-ink-faint line-through"
                  : "text-ink-faint"
            }`}
          >
            {reviewLabel[run.reviewStatus]}
          </span>
        )}
        <span className="hidden font-mono text-[11px] text-ink-soft md:inline">
          {run.pageCount > 0 ? `${run.pageCount} 页` : "—"} · {run.mode === "native" ? "原生" : "确定性"}
        </span>
        <span className={`hidden text-[11px] sm:inline-flex ${stamp.className}`}>{stamp.text}</span>
        <span className="w-20 text-right font-mono text-[11px] text-ink-faint">{date}</span>
        <span className="font-mono text-sm text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
          ↗
        </span>
      </button>
    </li>
  );
}
