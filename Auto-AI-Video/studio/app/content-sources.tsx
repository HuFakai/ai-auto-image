"use client";

import {
  Activity,
  Check,
  Clock3,
  ExternalLink,
  FileText,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  Rss,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Channel, ContentSource } from "@/lib/types";
import { DeleteControl } from "./delete-control";
import { Pagination } from "./pagination";

const stateLabel: Record<ContentSource["state"], string> = {
  idle: "等待下次采集",
  queued: "已进入采集队列",
  polling: "正在读取与策划",
  error: "上次采集异常",
};

export function ContentSources({ sources, channels, onChanged }: {
  sources: ContentSource[];
  channels: Channel[];
  onChanged: (message: string) => void;
}) {
  const [channelId, setChannelId] = useState("all");
  const [composer, setComposer] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [page, setPage] = useState(1);
  const visible = useMemo(
    () => sources.filter((source) => channelId === "all" || source.channel_id === channelId),
    [channelId, sources],
  );
  const active = sources.filter((source) => source.enabled).length;
  const fresh = sources.reduce((sum, source) => sum + (source.last_result.new_items ?? 0), 0);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(visible.length / 6)));
  const paged = visible.slice((currentPage - 1) * 6, currentPage * 6);

  async function patchSource(source: ContentSource, body: object, label: string) {
    setBusyId(source.id);
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(source.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(detailOf(result, "更新内容源失败"));
      onChanged(label);
    } catch (error) {
      onChanged(error instanceof Error ? error.message : "更新内容源失败");
    } finally { setBusyId(""); }
  }

  async function poll(source: ContentSource) {
    setBusyId(source.id);
    try {
      const response = await fetch(`/api/sources/${encodeURIComponent(source.id)}/poll`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(detailOf(result, "采集任务提交失败"));
      onChanged(`《${source.name}》已进入后台采集；完成后新选题会自动出现`);
    } catch (error) {
      onChanged(error instanceof Error ? error.message : "采集任务提交失败");
    } finally { setBusyId(""); }
  }

  return (
    <section className="source-panel full-panel" id="sources">
      <div className="section-heading source-heading">
        <div><span>02</span><h2>内容信号源</h2></div>
        <div className="source-heading-actions">
          <p>{active} 路自动监听 · 本轮发现 {fresh} 条新素材</p>
          <button onClick={() => setComposer(true)} disabled={!channels.length}><Plus size={14} />接入来源</button>
        </div>
      </div>

      <div className="source-console">
        <div className="source-console-copy">
          <RadioTower size={22} />
          <div><strong>EDITORIAL SIGNAL ROUTER</strong><span>Runner 到点触发，后台抓取与 Grok 策划不会阻塞视频生产。</span></div>
        </div>
        <label>监听频道<select value={channelId} onChange={(event) => { setChannelId(event.target.value); setPage(1); }}><option value="all">全部频道</option>{channels.map((channel) => <option value={channel.id} key={channel.id}>{channel.name}</option>)}</select></label>
      </div>

      <div className="source-grid">
        {paged.length ? paged.map((source) => {
          const channel = channels.find((item) => item.id === source.channel_id);
          const busy = busyId === source.id;
          return (
            <article className={`source-card ${source.state} ${source.enabled ? "" : "disabled"}`} key={source.id}>
              <header>
                <span className="source-kind">{source.kind === "rss" ? <Rss size={15} /> : <FileText size={15} />}{source.kind.toUpperCase()}</span>
                <span className={`source-state ${source.state}`}><i />{source.enabled ? stateLabel[source.state] : "监听已暂停"}</span>
              </header>
              <div className="source-copy">
                <span>{channel?.name || source.channel_id}</span>
                <h3>{source.name}</h3>
                <a href={source.url} target="_blank" rel="noreferrer">{source.url}<ExternalLink size={11} /></a>
              </div>
              <div className="source-numbers">
                <div><strong>{source.item_count}</strong><span>素材总数</span></div>
                <div><strong>+{source.last_result.new_items ?? 0}</strong><span>本轮新增</span></div>
                <div><strong>{source.last_result.candidate_count ?? 0}</strong><span>生成候选</span></div>
              </div>
              <div className="source-schedule">
                <span><Clock3 size={12} />每 {formatInterval(source.poll_interval_minutes)}采集</span>
                <span><Activity size={12} />下次 {source.enabled ? formatDate(source.next_poll_at) : "—"}</span>
              </div>
              {source.last_error ? <p className="source-error">{source.last_error}</p> : null}
              <footer>
                <button className="secondary" onClick={() => patchSource(source, { enabled: !source.enabled }, source.enabled ? `《${source.name}》已暂停监听` : `《${source.name}》已恢复监听`)} disabled={busy}>{source.enabled ? <Pause size={13} /> : <Play size={13} />}{source.enabled ? "暂停" : "恢复"}</button>
                <button onClick={() => poll(source)} disabled={busy || source.state === "queued" || source.state === "polling"}>{busy ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}立即采集</button>
                <DeleteControl resource="source" targetId={source.id} label={`内容源「${source.name}」`} onDeleted={onChanged} compact />
              </footer>
            </article>
          );
        }) : <div className="source-empty"><RadioTower size={28} /><strong>还没有接入内容信号</strong><span>添加 RSS 或公开文章页面，让新素材持续流入选题收件箱。</span></div>}
      </div>
      <Pagination page={currentPage} pageSize={6} total={visible.length} onPage={setPage} />
      {composer ? <SourceComposer channels={channels} defaultChannel={channelId === "all" ? channels[0]?.id : channelId} onClose={() => setComposer(false)} onCreated={(message) => { setComposer(false); onChanged(message); }} /> : null}
    </section>
  );
}

function SourceComposer({ channels, defaultChannel, onClose, onCreated }: {
  channels: Channel[];
  defaultChannel?: string;
  onClose: () => void;
  onCreated: (message: string) => void;
}) {
  const [channelId, setChannelId] = useState(defaultChannel || channels[0]?.id || "");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"rss" | "url">("rss");
  const [url, setUrl] = useState("");
  const [interval, setInterval] = useState(360);
  const [items, setItems] = useState(5);
  const [candidates, setCandidates] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !busy) onClose(); }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId, name, kind, url, poll_interval_minutes: interval, items_per_poll: items, candidates_per_item: candidates, enabled: true }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(detailOf(result, "内容源接入失败"));
      onCreated(`《${name}》已接入；Runner 下一轮会启动首次采集`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "内容源接入失败"); }
    finally { setBusy(false); }
  }

  return (
    <div className="editor-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="channel-editor source-composer" role="dialog" aria-modal="true" aria-labelledby="source-composer-title">
        <div className="editor-head"><div><span>NEW SIGNAL INPUT</span><h2 id="source-composer-title">接入内容来源</h2></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭内容源编辑器"><X size={17} /></button></div>
        <form onSubmit={submit}>
          <div className="source-composer-note"><Rss size={18} /><div><strong>RSS 适合持续监听，URL 适合定期重读一个页面</strong><p>系统只允许公开 HTTP(S) 地址，并阻止访问本机、内网及私有网段。</p></div></div>
          <div className="form-grid">
            <label>目标频道<select value={channelId} onChange={(event) => setChannelId(event.target.value)}>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
            <label>来源类型<select value={kind} onChange={(event) => setKind(event.target.value as "rss" | "url")}><option value="rss">RSS / Atom 订阅</option><option value="url">固定网页 URL</option></select></label>
            <label>来源名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：NASA 中文快讯" required /></label>
            <label>采集周期<select value={interval} onChange={(event) => setInterval(Number(event.target.value))}><option value={30}>每 30 分钟</option><option value={60}>每小时</option><option value={360}>每 6 小时</option><option value={720}>每 12 小时</option><option value={1440}>每天</option></select></label>
            <label className="source-url-field">公开地址<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" required /></label>
            <label>每轮最多素材<input type="number" min="1" max="30" value={items} onChange={(event) => setItems(Number(event.target.value))} /></label>
            <label>每条素材候选数<input type="number" min="1" max="10" value={candidates} onChange={(event) => setCandidates(Number(event.target.value))} /></label>
          </div>
          {error ? <p className="editor-feedback" role="alert">{error}</p> : null}
          <div className="editor-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" disabled={busy || !channelId}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{busy ? "正在接入…" : "接入并启用"}</button></div>
        </form>
      </section>
    </div>
  );
}

function formatInterval(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function formatDate(value?: string): string {
  if (!value) return "等待 Runner";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "待定" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function detailOf(payload: { detail?: unknown }, fallback: string): string {
  if (typeof payload.detail === "string") return payload.detail;
  if (Array.isArray(payload.detail)) return payload.detail.map((item) => typeof item === "object" && item && "msg" in item ? String(item.msg) : String(item)).join("；");
  return fallback;
}
