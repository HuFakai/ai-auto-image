"use client";

import { useEffect, useState } from "react";
import { TextRenderingModeSchema } from "@aai/shared-schemas";
import type { RunListItem, RunsListPayload } from "@/lib/types";

interface Props {
  initial: RunsListPayload;
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

export function Workbench({ initial }: Props) {
  const [data, setData] = useState<RunsListPayload>(initial);
  const [topic, setTopic] = useState("");
  const [aspectRatio, setAspectRatio] = useState("3:4");
  const [mode, setMode] = useState<string>("native");
  const [concurrency, setConcurrency] = useState<number>(initial.defaultConcurrency);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function submit() {
    if (!topic.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          aspectRatio,
          textRenderingMode: TextRenderingModeSchema.parse(mode),
          requestedImageConcurrency: concurrency,
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
          输入主题，生成结构化文案与整页图片；中文逐字可查，全程可追溯、可重试、可恢复。
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

        <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3">
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
        </div>
      </section>

      {/* 运行目录 */}
      <section className="rise" style={{ animationDelay: "160ms" }}>
        <div className="rule-double mb-2 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-lg font-bold">No.贰 · 最近运行</h2>
          <span className="kicker">{data.runs.length > 0 ? `${data.runs.length} 篇` : "空"}</span>
        </div>
        {data.runs.length === 0 ? (
          <p className="border border-dashed border-line-dark px-6 py-12 text-center text-sm text-ink-faint">
            目录还是空的 —— 写下第一个主题。
          </p>
        ) : (
          <ul>
            {data.runs.map((run, index) => (
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
