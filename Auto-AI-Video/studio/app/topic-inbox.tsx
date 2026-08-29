"use client";

import {
  ArchiveX,
  Check,
  ChevronDown,
  Clock3,
  Inbox,
  LoaderCircle,
  Pin,
  Plus,
  ShieldCheck,
  Sparkles,
  TestTube2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Channel, TopicCandidate, TopicCandidateStatus } from "@/lib/types";
import { DeleteControl } from "./delete-control";
import { Pagination } from "./pagination";

const statusLabels: Record<TopicCandidateStatus | "all", string> = {
  all: "全部",
  new: "待判断",
  pinned: "已钉住",
  approved: "已通过",
  deferred: "已延后",
  discarded: "已丢弃",
  consumed: "已生产",
};

export function TopicInbox({ topics, channels, onChanged }: {
  topics: TopicCandidate[];
  channels: Channel[];
  onChanged: (message: string) => void;
}) {
  const [channelId, setChannelId] = useState("all");
  const [status, setStatus] = useState<TopicCandidateStatus | "all">("new");
  const [composer, setComposer] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () => topics.filter((topic) =>
      (channelId === "all" || topic.channel_id === channelId)
      && (status === "all" || topic.status === status)),
    [channelId, status, topics],
  );
  const readyCount = topics.filter((item) => item.status === "pinned" || item.status === "approved").length;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / 8)));
  const paged = filtered.slice((currentPage - 1) * 8, currentPage * 8);

  async function decide(topic: TopicCandidate, nextStatus: TopicCandidateStatus) {
    setBusyId(topic.id);
    try {
      const response = await fetch(`/api/topics/${encodeURIComponent(topic.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: nextStatus,
          note: decisionNote(nextStatus),
          deferred_until: nextStatus === "deferred" ? new Date(Date.now() + 86_400_000).toISOString() : null,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "操作失败");
      onChanged(`《${topic.title}》${decisionNote(nextStatus)}`);
    } catch (error) {
      onChanged(error instanceof Error ? error.message : "选题操作失败");
    } finally { setBusyId(""); }
  }

  async function selectTitle(topic: TopicCandidate, variantId: string) {
    setBusyId(topic.id);
    try {
      const response = await fetch(`/api/topics/${encodeURIComponent(topic.id)}/title`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant_id: variantId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "标题选择失败");
      onChanged(`《${result.title}》已设为生产标题`);
    } catch (error) {
      onChanged(error instanceof Error ? error.message : "标题选择失败");
    } finally { setBusyId(""); }
  }

  return (
    <section className="topic-panel full-panel" id="topics">
      <div className="section-heading topic-heading">
        <div><span>03</span><h2>智能选题收件箱</h2></div>
        <div className="topic-heading-actions"><p>{readyCount} 条已进入 Runner 候选队列</p><button onClick={() => setComposer(true)} disabled={!channels.length}><Sparkles size={14} />生成候选</button></div>
      </div>
      <div className="topic-toolbar">
        <div className="topic-channel-filter">
          <label htmlFor="topic-channel">频道</label>
          <select id="topic-channel" value={channelId} onChange={(event) => { setChannelId(event.target.value); setPage(1); }}><option value="all">全部生产频道</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select>
        </div>
        <div className="topic-status-filter" aria-label="选题状态筛选">
          {(Object.keys(statusLabels) as Array<TopicCandidateStatus | "all">).map((value) => <button key={value} className={status === value ? "active" : ""} onClick={() => { setStatus(value); setPage(1); }}>{statusLabels[value]}<small>{topics.filter((item) => (value === "all" || item.status === value) && (channelId === "all" || item.channel_id === channelId)).length}</small></button>)}
        </div>
      </div>
      <div className="topic-list">
        {paged.length ? paged.map((topic) => (
          <TopicCard key={topic.id} topic={topic} channel={channels.find((item) => item.id === topic.channel_id)} busy={busyId === topic.id} onDecide={decide} onSelectTitle={selectTitle} onDeleted={onChanged} />
        )) : <div className="topic-empty"><Inbox size={26} /><strong>这个收件格还没有选题</strong><span>生成一批候选，或切换频道与状态。</span></div>}
      </div>
      <Pagination page={currentPage} pageSize={8} total={filtered.length} onPage={setPage} />
      {composer ? <TopicComposer channels={channels} defaultChannel={channelId === "all" ? channels[0]?.id : channelId} onClose={() => setComposer(false)} onGenerated={(message) => { setComposer(false); setStatus("new"); onChanged(message); }} /> : null}
    </section>
  );
}

function TopicCard({ topic, channel, busy, onDecide, onSelectTitle, onDeleted }: { topic: TopicCandidate; channel?: Channel; busy: boolean; onDecide: (topic: TopicCandidate, status: TopicCandidateStatus) => void; onSelectTitle: (topic: TopicCandidate, variantId: string) => void; onDeleted: (message: string) => void }) {
  const scoreEntries = [
    ["新颖", topic.scores.novelty, topic.score_reasons.novelty],
    ["具体", topic.scores.specificity, topic.score_reasons.specificity],
    ["可信", topic.scores.credibility, topic.score_reasons.credibility],
    ["栏目", topic.scores.channel_fit, topic.score_reasons.channel_fit],
  ] as const;
  return (
    <article className={`topic-card topic-${topic.status}`}>
      <div className="topic-score" style={{ "--score": `${topic.scores.overall * 3.6}deg` } as React.CSSProperties}><strong>{topic.scores.overall}</strong><span>SCORE</span></div>
      <div className="topic-copy">
        <div className="topic-kicker"><span>{channel?.name || topic.channel_id}</span><span className={`topic-source ${topic.source_type}`}>{topic.source_type === "seed_fallback" ? "SEED 回退" : topic.source_type.toUpperCase()}</span>{topic.duplicate_of ? <span className="duplicate-flag">近似内容</span> : null}</div>
        <h3>{topic.title}</h3>
        <p>{topic.topic}</p>
        <div className="topic-assets"><span>封面 / {topic.cover_copy || "待补"}</span>{topic.tags.map((tag) => <small key={tag}>#{tag}</small>)}</div>
        {topic.semantic_terms?.length ? <div className="semantic-signal"><span>VECTOR {topic.scores.semantic_similarity ?? 0}%</span>{topic.semantic_terms.slice(0, 6).map((term) => <small key={term}>{term}</small>)}</div> : null}
        {topic.title_variants?.length > 1 ? <details className="title-experiment"><summary><TestTube2 size={13} />标题实验 · {topic.title_variants.length} 个假设 <ChevronDown size={13} /></summary><div>{topic.title_variants.map((variant) => <button type="button" key={variant.id} className={variant.selected ? "selected" : ""} onClick={() => onSelectTitle(topic, variant.id)} disabled={busy || variant.selected || topic.status === "consumed"}><span>{variant.angle.toUpperCase()}</span><strong>{variant.title}</strong><small>{variant.hypothesis}</small>{variant.selected ? <Check size={13} /> : null}</button>)}</div></details> : null}
        <details className="topic-score-detail"><summary>查看评分依据 <ChevronDown size={13} /></summary><div>{scoreEntries.map(([label, score, reason]) => <div className="topic-score-row" key={label}><span>{label}</span><div><i style={{ width: `${score}%` }} /></div><strong>{score}</strong><p>{reason}</p></div>)}</div></details>
      </div>
      <div className="topic-decision">
        <span className={`topic-status ${topic.status}`}>{statusLabels[topic.status]}</span>
        {topic.status === "consumed" ? <small><Check size={12} />已进入任务</small> : (
          <>
            <button className="pin-action" onClick={() => onDecide(topic, "pinned")} disabled={busy || topic.status === "pinned"}><Pin size={13} />优先生产</button>
            <button className="approve-action" onClick={() => onDecide(topic, "approved")} disabled={busy || topic.status === "approved"}>{busy ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}通过</button>
            <button onClick={() => onDecide(topic, "deferred")} disabled={busy}><Clock3 size={13} />明天再看</button>
            <button className="discard-action" onClick={() => onDecide(topic, "discarded")} disabled={busy}><ArchiveX size={13} />丢弃</button>
          </>
        )}
        <DeleteControl resource="topic" targetId={topic.id} label={`选题「${topic.title}」`} onDeleted={onDeleted} compact />
      </div>
    </article>
  );
}

function TopicComposer({ channels, defaultChannel, onClose, onGenerated }: { channels: Channel[]; defaultChannel?: string; onClose: () => void; onGenerated: (message: string) => void }) {
  const [channelId, setChannelId] = useState(defaultChannel || channels[0]?.id || "");
  const [count, setCount] = useState(6);
  const [sourceType, setSourceType] = useState<"prompt" | "markdown" | "theme_pool">("prompt");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !busy) onClose(); }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  async function generate(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/topics/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel_id: channelId, count, source_type: sourceType, source_label: sourceLabel || null, source_text: sourceText }) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "候选生成失败");
      onGenerated(`已生成 ${result.count} 条候选${result.fallback ? "；Grok 暂不可用，本批明确标记为种子回退" : ""}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "候选生成失败"); }
    finally { setBusy(false); }
  }
  return (
    <div className="editor-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="channel-editor topic-composer" role="dialog" aria-modal="true" aria-labelledby="topic-composer-title">
        <div className="editor-head"><div><span>EDITORIAL INTAKE</span><h2 id="topic-composer-title">生成一批候选选题</h2></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭选题生成器"><X size={17} /></button></div>
        <form onSubmit={generate}>
          <div className="topic-composer-note"><Sparkles size={17} /><div><strong>Grok 负责发散，评分器负责解释</strong><p>候选只进入收件箱；通过或钉住后，Runner 才会自动消费。</p></div></div>
          <div className="form-grid"><label>目标频道<select value={channelId} onChange={(event) => setChannelId(event.target.value)}>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label><label>候选数量<input type="number" min="1" max="20" value={count} onChange={(event) => setCount(Number(event.target.value))} /></label><label>输入方式<select value={sourceType} onChange={(event) => setSourceType(event.target.value as typeof sourceType)}><option value="prompt">沿用频道策划提示</option><option value="markdown">文章 / Markdown 摘要</option><option value="theme_pool">主题池</option></select></label><label>来源备注<input value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} placeholder="例如：本周天文热点" /></label></div>
          <label>素材或主题简报 <small>可选；主题池建议每行一个</small><textarea className="topic-source-input" value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="粘贴文章摘要、Markdown，或输入一组希望展开的主题。Grok 会结合频道参数与近期历史生成候选。" /></label>
          {error ? <p className="editor-feedback" role="alert">{error}</p> : null}
          <div className="editor-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" disabled={busy || !channelId}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}{busy ? "Grok 正在策划…" : "生成到收件箱"}</button></div>
        </form>
      </section>
    </div>
  );
}

function decisionNote(status: TopicCandidateStatus): string {
  return { new: "已恢复待判断", pinned: "已钉住，将优先进入生产", approved: "已通过，将按评分进入生产", deferred: "已延后到明天", discarded: "已丢弃", consumed: "已生产" }[status];
}
