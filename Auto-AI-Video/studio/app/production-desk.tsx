"use client";

import {
  Activity,
  ArrowUpRight,
  Bot,
  BookOpenCheck,
  Boxes,
  Check,
  CheckCircle2,
  CircleAlert,
  Copy,
  Clock3,
  Download,
  Film,
  Gauge,
  Layers3,
  LoaderCircle,
  Pause,
  PencilLine,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  SlidersHorizontal,
  ShieldAlert,
  Sparkles,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { Channel, ChannelVisualMemory, ChannelVoicePreset, ChannelWatermark, ContentCheck, DashboardData, HyperFramesTemplate, HyperFramesTemplatePreview, ProductionJob, RunnerStatus, StoryboardScene, WhiteboardTemplate } from "@/lib/types";
import {
  defaultMotionPool,
  defaultTransitionPool,
  imageMotionOptions,
  sceneTransitionOptions,
} from "@/lib/scene-direction";
import { ContentSources } from "./content-sources";
import { TopicInbox } from "./topic-inbox";
import { DeleteControl } from "./delete-control";
import { ActionFeedback } from "./action-feedback";
import { AttentionCenter } from "./attention-center";
import { WhiteboardTemplatePicker } from "./whiteboard-template-picker";
import { CustomScriptStudio, type ScriptRecommendationState } from "./custom-script-studio";
import { ActionConfirmDialog } from "./action-confirm-dialog";
import { Pagination } from "./pagination";
import { GlobalSearch } from "./global-search";
import { BatchParameterReview } from "./batch-parameter-review";

const ProjectWorkspace = dynamic(
  () => import("./project-workspace").then((module) => module.ProjectWorkspace),
  { ssr: false },
);

const ProducerAssistant = dynamic(
  () => import("./producer-assistant").then((module) => module.ProducerAssistant),
  { ssr: false },
);

const statusLabel: Record<string, string> = {
  planned: "已规划",
  planning: "规划分镜",
  awaiting_storyboard: "待确认分镜",
  submitting: "提交中",
  pending: "排队中",
  running: "生成中",
  ready: "待审核",
  failed: "失败",
  published: "已发布",
  cancelled: "已取消",
};

const reviewLabel: Record<string, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已驳回",
  not_ready: "未成片",
};

const runnerStateLabel: Record<RunnerStatus["state"], string> = {
  stopped: "OFF",
  starting: "STARTING",
  running: "ON",
  stopping: "STOPPING",
  failed: "ERROR",
};

const subtitleEffects = [
  { id: "static", label: "静态字幕", detail: "全程清晰显示", preview: "字幕保持稳定" },
  { id: "fade_up", label: "淡入上浮", detail: "轻量、适合大多数内容", preview: "字幕轻轻入场" },
  { id: "typewriter", label: "打字机", detail: "逐字出现，强调叙述节奏", preview: "逐字讲清重点" },
  { id: "word_pop", label: "词语弹入", detail: "逐词强调，节奏更活跃", preview: "关键词逐个出现" },
] as const;

type Mutation = (label: string, url: string, body?: object) => Promise<void>;

export function ProductionDesk({ initialData }: { initialData: DashboardData }) {
  const [data, setData] = useState(initialData);
  const [filter, setFilter] = useState("all");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [libraryChannel, setLibraryChannel] = useState("all");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [selectedVideos, setSelectedVideos] = useState<Set<string>>(() => new Set());
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(() => new Set());
  const [batchNote, setBatchNote] = useState("");
  const [batchBusy, setBatchBusy] = useState("");
  const [queueBatchBusy, setQueueBatchBusy] = useState("");
  const [runnerBusy, setRunnerBusy] = useState<"" | "start" | "stop">("");
  const [batchParameterOpen, setBatchParameterOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [feedbackKind, setFeedbackKind] = useState<"pending" | "success" | "error">("success");
  const [streamOnline, setStreamOnline] = useState(false);
  const [editing, setEditing] = useState<Channel | "new" | null>(null);
  const [workspaceJob, setWorkspaceJob] = useState<ProductionJob | null>(null);
  const [storyboardJob, setStoryboardJob] = useState<ProductionJob | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [customScriptOpen, setCustomScriptOpen] = useState(false);
  const [scriptRecommendationState, setScriptRecommendationState] = useState<ScriptRecommendationState>({ phase: "idle", message: "" });
  const [channelPage, setChannelPage] = useState(1);
  const [queuePage, setQueuePage] = useState(1);
  const [libraryPage, setLibraryPage] = useState(1);
  const [isPending, startTransition] = useTransition();
  const refreshInFlight = useRef(false);
  const hasActiveJobs = data.jobs.some((job) => ["planned", "planning", "submitting", "pending", "running"].includes(job.status) || ["pending", "running"].includes(job.progress?.task_status || ""))
    || ["starting", "stopping"].includes(data.runner.state);
  const showFeedback = useCallback((message: string, kind: "pending" | "success" | "error" = "success") => {
    setFeedback(message);
    setFeedbackKind(kind);
  }, []);
  const dismissFeedback = useCallback(() => setFeedback(""), []);

  const refresh = useCallback(() => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    startTransition(async () => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch("/api/dashboard", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`dashboard request failed (${response.status})`);
        }
        setData((await response.json()) as DashboardData);
      } catch (error) {
        // API 重启或端口切换期间保留现有数据，只标记连接状态，避免浏览器出现未捕获的
        // TypeError: Failed to fetch 覆盖整个生产台。
        setData((current) => ({
          ...current,
          connected: false,
          checkedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "无法连接 Pixelle API",
        }));
      } finally {
        window.clearTimeout(timeout);
        refreshInFlight.current = false;
      }
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(refresh, hasActiveJobs ? 3_000 : 15_000);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs, refresh]);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.addEventListener("production", () => {
      setStreamOnline(true);
      refresh();
    });
    events.onerror = () => setStreamOnline(false);
    return () => events.close();
  }, [refresh]);

  const mutate = useCallback<Mutation>(async (label, url, body) => {
    showFeedback(`${label}处理中…`, "pending");
    const response = await fetch(url, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    if (!response.ok) {
      const detail = typeof payload.detail === "string" ? payload.detail : "操作失败";
      showFeedback(`${label}失败：${detail}`, "error");
      throw new Error(detail);
    }
    showFeedback(`${label}完成`);
    refresh();
  }, [refresh, showFeedback]);

  const toggleRunner = useCallback(async () => {
    if (runnerBusy || !data.connected) return;
    const action = data.runner.enabled ? "stop" : "start";
    const label = action === "start" ? "开启持续生产" : "关闭持续生产";
    setRunnerBusy(action);
    showFeedback(`${label}处理中…`, "pending");
    try {
      const response = await fetch(`/api/runner/${action}`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(detailOf(payload, `${label}失败`));
      setData((current) => ({ ...current, runner: payload as RunnerStatus }));
      showFeedback(action === "start" ? "持续生产已开启" : "持续生产已关闭");
      refresh();
    } catch (caught) {
      showFeedback(caught instanceof Error ? caught.message : `${label}失败`, "error");
    } finally {
      setRunnerBusy("");
    }
  }, [data.connected, data.runner.enabled, refresh, runnerBusy, showFeedback]);

  const visibleJobs = useMemo(
    () => data.jobs.filter((job) => filter === "all" || job.status === filter),
    [data.jobs, filter],
  );
  const visibleVideos = useMemo(
    () => data.videos.filter(
      (job) => (libraryFilter === "all" || job.review_status === libraryFilter)
        && (libraryChannel === "all" || job.channel_id === libraryChannel)
        && `${job.title || ""} ${job.topic}`.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase()),
    ),
    [data.videos, libraryChannel, libraryFilter, libraryQuery],
  );
  const currentChannelPage = Math.min(channelPage, Math.max(1, Math.ceil(data.channels.length / 6)));
  const currentQueuePage = Math.min(queuePage, Math.max(1, Math.ceil(visibleJobs.length / 10)));
  const currentLibraryPage = Math.min(libraryPage, Math.max(1, Math.ceil(visibleVideos.length / 9)));
  const pagedChannels = data.channels.slice((currentChannelPage - 1) * 6, currentChannelPage * 6);
  const pagedJobs = visibleJobs.slice((currentQueuePage - 1) * 10, currentQueuePage * 10);
  const pagedVideos = visibleVideos.slice((currentLibraryPage - 1) * 9, currentLibraryPage * 9);
  const selectableVideos = visibleVideos.filter((job) => job.status === "ready" && job.review_status !== "approved");
  const reviewableIds = useMemo(
    () => new Set(data.videos.filter((job) => job.status === "ready" && job.review_status !== "approved").map((job) => job.id)),
    [data.videos],
  );
  const effectiveSelectedVideos = useMemo(
    () => new Set([...selectedVideos].filter((id) => reviewableIds.has(id))),
    [reviewableIds, selectedVideos],
  );
  const queueJobIds = useMemo(() => new Set(data.jobs.map((job) => job.id)), [data.jobs]);
  const effectiveSelectedJobs = useMemo(
    () => new Set([...selectedJobs].filter((id) => queueJobIds.has(id))),
    [queueJobIds, selectedJobs],
  );

  function toggleVideo(id: string) {
    setSelectedVideos((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleJob(id: string) {
    setSelectedJobs((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function batchQueueAction(action: "retry" | "delete") {
    const jobIds = [...effectiveSelectedJobs];
    if (!jobIds.length || queueBatchBusy) return;
    setQueueBatchBusy(action);
    const label = action === "retry" ? "批量重试" : "批量删除";
    showFeedback(`正在预检${label}影响…`, "pending");
    try {
      const previewResponse = await fetch(`/api/jobs/batch/${action}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_ids: jobIds }),
      });
      const preview = await previewResponse.json();
      if (!previewResponse.ok) throw new Error(detailOf(preview, `${label}预检失败`));
      if (preview.blocked?.length) {
        const reason = preview.blocked.slice(0, 4).map((item: { title?: string; job_id: string; reason: string }) => `${item.title || item.job_id}：${item.reason}`).join("；");
        throw new Error(`预检阻止执行：${reason}`);
      }
      const prompt = action === "retry"
        ? `确认重试 ${preview.eligible.length} 条失败任务？任务会沿用原 ID 和输出目录。`
        : `确认永久删除 ${preview.eligible.length} 条任务及其项目、版本、分镜和整个 output/temp 任务目录？此操作不可恢复。`;
      if (!window.confirm(prompt)) return;
      const response = await fetch(`/api/jobs/batch/${action}`, {
        method: action === "retry" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "retry"
          ? { job_ids: jobIds }
          : { job_ids: jobIds, confirmation: "DELETE", delete_files: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(detailOf(payload, `${label}失败`));
      setSelectedJobs(new Set());
      showFeedback(action === "retry" ? `已重试 ${payload.completed} 条任务` : `已删除 ${payload.deleted} 条任务`);
      refresh();
    } catch (caught) {
      showFeedback(caught instanceof Error ? caught.message : `${label}失败`, "error");
    } finally {
      setQueueBatchBusy("");
    }
  }

  async function batchReview(decision: "approved" | "rejected") {
    const jobIds = [...effectiveSelectedVideos];
    if (!jobIds.length || batchBusy) return;
    if (decision === "rejected" && !batchNote.trim()) {
      showFeedback("批量驳回前请填写统一修改意见", "error");
      return;
    }
    setBatchBusy(decision);
    showFeedback("正在预检批量审核影响…", "pending");
    const body = { job_ids: jobIds, decision, note: batchNote.trim() || null };
    try {
      const previewResponse = await fetch("/api/reviews/batch/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const preview = await previewResponse.json();
      if (!previewResponse.ok) throw new Error(detailOf(preview, "批量审核预检失败"));
      if (preview.blocked?.length) {
        const reason = preview.blocked.slice(0, 3).map((item: { title?: string; job_id: string; reason: string }) => `${item.title || item.job_id}：${item.reason}`).join("；");
        throw new Error(`预检阻止执行：${reason}`);
      }
      const label = decision === "approved" ? "通过" : "驳回";
      if (!window.confirm(`确认一次性${label} ${preview.eligible.length} 条成片？该批次将全成或全败。`)) return;
      const response = await fetch("/api/reviews/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(detailOf(payload, "批量审核失败"));
      setSelectedVideos(new Set());
      setBatchNote("");
      showFeedback(`已批量${label} ${payload.completed} 条成片`);
      refresh();
    } catch (caught) {
      showFeedback(caught instanceof Error ? caught.message : "批量审核失败", "error");
    } finally {
      setBatchBusy("");
    }
  }
  const totalReady = data.channels.reduce((sum, channel) => sum + channel.review_pending, 0);
  const totalFlight = data.channels.reduce((sum, channel) => sum + channel.in_flight, 0);
  const totalToday = data.channels.reduce((sum, channel) => sum + channel.completed_today, 0);
  const totalFailed = data.channels.reduce((sum, channel) => sum + channel.failed, 0);

  return (
    <main className="shell">
      <ActionFeedback message={feedback} kind={feedbackKind} onDismiss={dismissFeedback} />
      {scriptRecommendationState.phase !== "idle" ? (
        <div
          className={`script-background-status ${scriptRecommendationState.phase}`}
          role={scriptRecommendationState.phase === "error" ? "alert" : "status"}
          aria-live={scriptRecommendationState.phase === "error" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          {scriptRecommendationState.phase === "running" ? <LoaderCircle className="spin" size={15} /> : scriptRecommendationState.phase === "ready" ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
          <span><strong>{scriptRecommendationState.phase === "running" ? "AI 编排中" : scriptRecommendationState.phase === "ready" ? "制作单已就绪" : "AI 编排失败"}</strong><small>{scriptRecommendationState.message}</small></span>
          {scriptRecommendationState.phase !== "running" ? <button type="button" onClick={() => setCustomScriptOpen(true)}>打开制作单</button> : null}
        </div>
      ) : null}
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Pixelle Production Desk">
          <span className="brand-mark"><Film size={18} /></span>
          <span>PIXELLE / PRODUCTION DESK</span>
        </a>
        <nav className="desk-nav" aria-label="主导航">
          <a href="#channels">频道</a><a href="#sources">来源</a><a href="#topics">选题</a><a href="#queue">队列</a><a href="#library">成片</a>
        </nav>
        <div className="top-actions">
          <GlobalSearch />
          <button
            type="button"
            className={`runner-switch ${data.runner.enabled ? "active" : ""} ${data.runner.state === "failed" ? "failed" : ""}`}
            role="switch"
            aria-checked={data.runner.enabled}
            aria-label={data.runner.enabled ? "关闭持续生产 Runner" : "开启持续生产 Runner"}
            title={data.runner.last_error || "控制持续生产 Runner"}
            disabled={Boolean(runnerBusy) || !data.connected || ["starting", "stopping"].includes(data.runner.state)}
            onClick={() => void toggleRunner()}
          >
            {runnerBusy || ["starting", "stopping"].includes(data.runner.state) ? <LoaderCircle className="spin" size={14} /> : data.runner.enabled ? <Pause size={14} /> : <Play size={14} />}
            <span><small>持续生产</small><strong>{runnerStateLabel[data.runner.state]}</strong></span>
          </button>
          <a className="settings-launch" href="/settings"><Settings2 size={15} />设置</a>
          <button className="script-launch" onClick={() => setCustomScriptOpen(true)}>
            <PencilLine size={15} />自定义文案
          </button>
          <button className="producer-launch" onClick={() => setAssistantOpen(true)}>
            <Bot size={15} />AI 制片
          </button>
          <div className={`connection ${data.connected ? "online" : "offline"}`}>
            <Radio size={14} aria-hidden="true" />
            {data.connected ? (streamOnline ? "实时链路在线" : "生产链路在线") : "等待 API 重启"}
          </div>
          <button className="icon-button" onClick={refresh} disabled={isPending} aria-label="刷新数据">
            <RefreshCw size={17} className={isPending ? "spin" : ""} />
          </button>
        </div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow"><Sparkles size={14} /> ALWAYS-ON VIDEO OPERATIONS</p>
          <h1>让选题变成<br /><em>稳定的视频库存。</em></h1>
        </div>
        <div className="hero-note">
          <span>系统节拍</span>
          <strong>{streamOnline ? "事件实时推送" : "每 15 秒同步"}</strong>
          <p>渠道独立补货、人工审核门禁、失败任务同 ID 重试。创作台负责判断，Runner 负责不停生产。</p>
        </div>
      </section>

      {!data.connected ? (
        <div className="notice" role="alert">
          <CircleAlert size={18} />
          <div><strong>控制接口尚未接通</strong><span>启动或重启 API 后会自动恢复：{data.error}</span></div>
        </div>
      ) : null}

      <section className="metrics" aria-label="生产概览">
        <Metric label="等待审核" value={totalReady} detail="通过后才可进入发布队列" icon={<Layers3 />} accent />
        <Metric label="正在生产" value={totalFlight} detail="包括排队与生成中" icon={<LoaderCircle />} />
        <Metric label="今日完成" value={totalToday} detail="按 Runner 时区统计" icon={<Check />} />
        <Metric label="累计失败" value={totalFailed} detail="查看错误后可同 ID 重试" icon={<CircleAlert />} danger={totalFailed > 0} />
      </section>

      <section className="operations-metrics" aria-label="运行性能">
        <OperationsMetric icon={<Activity />} label="当前执行" value={data.runtimeMetrics?.tasks.active_futures ?? "—"} detail={data.runtimeMetrics?.tasks.unlimited_concurrency ? "渲染并发不限" : "已配置显式上限"} />
        <OperationsMetric icon={<Gauge />} label="排队 P95" value={formatMilliseconds(data.runtimeMetrics?.tasks.queue_wait_ms.p95)} detail={`${data.runtimeMetrics?.tasks.queue_wait_ms.count ?? 0} 条持久化样本`} />
        <OperationsMetric icon={<Clock3 />} label="运行 P95" value={formatMilliseconds(data.runtimeMetrics?.tasks.run_duration_ms.p95)} detail={`${data.runtimeMetrics?.tasks.run_duration_ms.count ?? 0} 条持久化样本`} />
      </section>

      <AttentionCenter
        channels={data.channels}
        jobs={data.jobs}
        onQueue={(status) => {
          setFilter(status);
          document.getElementById("queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        onLibrary={() => {
          setLibraryFilter("pending");
          document.getElementById("library")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
        onChannel={(channel) => setEditing(channel)}
        onAssistant={() => setAssistantOpen(true)}
      />

      <section className="channel-panel" id="channels">
        <div className="section-heading"><div><span>01</span><h2>频道生产轨道</h2></div><div className="heading-actions"><p>修改后 Runner 下一轮自动热加载</p><button onClick={() => setEditing("new")}><Plus size={14} />新建频道</button></div></div>
        <div className="channel-grid">
          {data.channels.length ? pagedChannels.map((channel) => (
            <ChannelCard key={channel.id} channel={channel} mutate={mutate} onEdit={() => setEditing(channel)} onDeleted={(message) => { showFeedback(message); refresh(); }} />
          )) : <Empty label="API 接通后显示频道生产水位" />}
        </div>
        <Pagination page={currentChannelPage} pageSize={6} total={data.channels.length} onPage={setChannelPage} />
      </section>

      <ContentSources
        sources={data.sources ?? []}
        channels={data.channels}
        onChanged={(message) => { showFeedback(message); refresh(); }}
      />

      <TopicInbox
        topics={data.topics ?? []}
        channels={data.channels}
        onChanged={(message) => { showFeedback(message); refresh(); }}
      />

      <section className="queue-panel full-panel" id="queue">
        <div className="section-heading"><div><span>04</span><h2>生产队列</h2></div><p>{visibleJobs.length} 条任务</p></div>
        <FilterBar values={["all", "awaiting_storyboard", "planning", "running", "pending", "ready", "failed", "published", "cancelled"]} selected={filter} onSelect={(value) => { setFilter(value); setQueuePage(1); }} labels={statusLabel} />
        <div className={`batch-review-bar queue-batch-bar ${effectiveSelectedJobs.size ? "active" : ""}`}>
          <div><Boxes size={15} /><strong>{effectiveSelectedJobs.size ? `已选择 ${effectiveSelectedJobs.size} 条` : "批量操作"}</strong><span>重试仅接受失败任务；删除会先检查活动任务与关联资源</span></div>
          <div className="batch-review-actions">
            <button onClick={() => setSelectedJobs(new Set(pagedJobs.map((job) => job.id)))} disabled={!pagedJobs.length || Boolean(queueBatchBusy)}>全选当前页</button>
            {effectiveSelectedJobs.size ? <button onClick={() => setSelectedJobs(new Set())} disabled={Boolean(queueBatchBusy)}>清空</button> : null}
            <button onClick={() => setBatchParameterOpen(true)} disabled={!effectiveSelectedJobs.size || Boolean(queueBatchBusy)}><SlidersHorizontal size={13} />批量参数</button>
            <button className="approve" onClick={() => void batchQueueAction("retry")} disabled={!effectiveSelectedJobs.size || Boolean(queueBatchBusy)}>{queueBatchBusy === "retry" ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}批量重试</button>
            <button className="reject" onClick={() => void batchQueueAction("delete")} disabled={!effectiveSelectedJobs.size || Boolean(queueBatchBusy)}>{queueBatchBusy === "delete" ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}批量删除</button>
          </div>
        </div>
        <div className="job-list">
          {pagedJobs.length ? pagedJobs.map((job) => (
            <JobRow key={job.id} job={job} channelName={job.channel_name?.trim() || data.channels.find((channel) => channel.id === job.channel_id)?.name || job.channel_id} mutate={mutate} selected={effectiveSelectedJobs.has(job.id)} onSelect={() => toggleJob(job.id)} onOpenStoryboard={() => setStoryboardJob(job)} onDeleted={(message) => { showFeedback(message); refresh(); }} />
          )) : <Empty label="当前筛选条件下没有任务" />}
        </div>
        <Pagination page={currentQueuePage} pageSize={10} total={visibleJobs.length} onPage={setQueuePage} />
      </section>

      <section className="library-panel full-panel" id="library">
        <div className="section-heading"><div><span>05</span><h2>成片库与审核</h2></div><p>{visibleVideos.length} 条成片</p></div>
        <div className="library-tools">
          <FilterBar values={["all", "pending", "approved", "rejected"]} selected={libraryFilter} onSelect={(value) => { setLibraryFilter(value); setLibraryPage(1); }} labels={reviewLabel} />
          <label><span className="sr-only">按频道筛选成片</span><select value={libraryChannel} onChange={(event) => { setLibraryChannel(event.target.value); setLibraryPage(1); }}><option value="all">全部频道</option>{data.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>
          <label className="library-search"><span className="sr-only">搜索成片</span><input type="search" value={libraryQuery} onChange={(event) => { setLibraryQuery(event.target.value); setLibraryPage(1); }} placeholder="搜索标题或选题" /></label>
        </div>
        <div className={`batch-review-bar ${effectiveSelectedVideos.size ? "active" : ""}`}>
          <div><Boxes size={15} /><strong>{effectiveSelectedVideos.size ? `已选择 ${effectiveSelectedVideos.size} 条` : "批量审核"}</strong><span>先预检质量门禁，再原子写入审核结果</span></div>
          <div className="batch-review-actions">
            <button onClick={() => setSelectedVideos(new Set(selectableVideos.map((job) => job.id)))} disabled={!selectableVideos.length || Boolean(batchBusy)}>选择当前可审</button>
            {effectiveSelectedVideos.size ? <button onClick={() => setSelectedVideos(new Set())} disabled={Boolean(batchBusy)}>清空</button> : null}
            <input value={batchNote} onChange={(event) => setBatchNote(event.target.value)} placeholder="批量驳回的统一修改意见" maxLength={2000} />
            <button className="approve" onClick={() => void batchReview("approved")} disabled={!effectiveSelectedVideos.size || Boolean(batchBusy)}>{batchBusy === "approved" ? <LoaderCircle className="spin" size={13} /> : <CheckCircle2 size={13} />}批量通过</button>
            <button className="reject" onClick={() => void batchReview("rejected")} disabled={!effectiveSelectedVideos.size || !batchNote.trim() || Boolean(batchBusy)}>{batchBusy === "rejected" ? <LoaderCircle className="spin" size={13} /> : <X size={13} />}批量驳回</button>
          </div>
        </div>
        <div className="video-grid">
          {pagedVideos.length ? pagedVideos.map((job) => (
            <VideoCard key={job.id} job={job} channelName={job.channel_name?.trim() || data.channels.find((channel) => channel.id === job.channel_id)?.name || job.channel_id} mutate={mutate} onOpen={() => setWorkspaceJob(job)} onDeleted={(message) => { showFeedback(message); refresh(); }} selected={effectiveSelectedVideos.has(job.id)} onSelect={job.status === "ready" && job.review_status !== "approved" ? () => toggleVideo(job.id) : undefined} />
          )) : <Empty label="生成完成的视频会在这里等待审核" />}
        </div>
        <Pagination page={currentLibraryPage} pageSize={9} total={visibleVideos.length} onPage={setLibraryPage} />
      </section>

      {editing ? <ChannelEditor key={editing === "new" ? "new" : editing.id} channel={editing === "new" ? undefined : editing} templates={data.hyperframesTemplates} whiteboardTemplates={data.whiteboardTemplates} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); showFeedback("频道配置已保存，Runner 将自动热加载"); refresh(); }} /> : null}
      {workspaceJob ? <ProjectWorkspace job={workspaceJob} onClose={() => setWorkspaceJob(null)} /> : null}
      {storyboardJob ? <StoryboardReview job={storyboardJob} onClose={() => setStoryboardJob(null)} onChanged={() => { setStoryboardJob(null); refresh(); }} /> : null}
      {assistantOpen ? <ProducerAssistant onClose={() => setAssistantOpen(false)} onChanged={(message, kind = "success") => { showFeedback(message, kind); refresh(); }} /> : null}
      {batchParameterOpen ? <BatchParameterReview jobIds={[...effectiveSelectedJobs]} onClose={() => setBatchParameterOpen(false)} onComplete={(message) => { setBatchParameterOpen(false); setSelectedJobs(new Set()); showFeedback(message); refresh(); }} /> : null}
      <CustomScriptStudio
        channels={data.channels}
        whiteboardTemplates={data.whiteboardTemplates}
        isOpen={customScriptOpen}
        onClose={() => setCustomScriptOpen(false)}
        onCreated={(message) => { setCustomScriptOpen(false); setScriptRecommendationState({ phase: "idle", message: "" }); showFeedback(message); refresh(); }}
        onRecommendationStateChange={setScriptRecommendationState}
      />
    </main>
  );
}

function Metric({ label, value, detail, icon, accent, danger }: { label: string; value: number; detail: string; icon: React.ReactNode; accent?: boolean; danger?: boolean }) {
  return <article className={`metric ${accent ? "accent" : ""} ${danger ? "danger" : ""}`}><div className="metric-icon">{icon}</div><span>{label}</span><strong>{String(value).padStart(2, "0")}</strong><p>{detail}</p></article>;
}

function OperationsMetric({ label, value, detail, icon }: { label: string; value: string | number; detail: string; icon: React.ReactNode }) {
  return <article><div>{icon}<span>{label}</span></div><strong>{value}</strong><small>{detail}</small></article>;
}

function formatMilliseconds(value?: number | null) {
  if (value == null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function ChannelCard({ channel, mutate, onEdit, onDeleted }: { channel: Channel; mutate: Mutation; onEdit: () => void; onDeleted: (message: string) => void }) {
  const [busy, setBusy] = useState("");
  const target = Math.max(channel.inventory.ready_target, 1);
  const progress = Math.min((channel.ready / target) * 100, 100);
  async function action(name: "pause" | "resume" | "publish", label: string, body?: object) {
    setBusy(name);
    try { await mutate(label, `/api/channels/${encodeURIComponent(channel.id)}/${name}`, body); }
    finally { setBusy(""); }
  }
  return (
    <article className={`channel-card ${channel.paused ? "paused" : ""}`}>
      <div className="channel-top"><span className="channel-index">{channel.id.slice(0, 2).toUpperCase()}</span><span className={`channel-state ${channel.paused ? "paused" : "live"}`}>{channel.paused ? "已暂停" : "自动补货"}</span></div>
      <h3>{channel.name}</h3>
      <p>今日 {channel.completed_today}/{channel.inventory.daily_target} · 进行中 {channel.in_flight}/{channel.inventory.max_in_flight}</p>
      <div className="waterline"><span style={{ width: `${progress}%` }} /></div>
      <div className="review-line"><span>待审核 {channel.review_pending}</span><span>已通过 {channel.approved}</span><span>已驳回 {channel.rejected}</span></div>
      <div className="channel-footer">
        <strong>{channel.ready}<small> / {target} 成片</small></strong>
        <div className="button-cluster">
          <button className="secondary" onClick={onEdit} disabled={Boolean(busy)}><Settings2 size={14} />配置</button>
          <button className="secondary" onClick={() => action(channel.paused ? "resume" : "pause", channel.paused ? "恢复频道" : "暂停频道")} disabled={Boolean(busy)}>{channel.paused ? <Play size={14} /> : <Pause size={14} />}{channel.paused ? "恢复" : "暂停"}</button>
          <button onClick={() => action("publish", "标记发布", { count: 1 })} disabled={!channel.approved || Boolean(busy)}>{busy === "publish" ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}发布 1 条</button>
          <DeleteControl resource="channel" targetId={channel.id} label={`频道「${channel.name}」`} onDeleted={onDeleted} compact />
        </div>
      </div>
    </article>
  );
}

function ChannelEditor({ channel, templates, whiteboardTemplates, onClose, onSaved }: { channel?: Channel; templates: HyperFramesTemplate[]; whiteboardTemplates: WhiteboardTemplate[]; onClose: () => void; onSaved: () => void }) {
  const [creating, setCreating] = useState(!channel);
  const [draft, setDraft] = useState<Channel>(() => channel ? { ...structuredClone(channel), quality: channel.quality || { auto_repair: false }, video: { ...structuredClone(channel.video), limit_scenes: channel.video.limit_scenes ?? true } } : blankChannel());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [livePreview, setLivePreview] = useState<HyperFramesTemplatePreview | null>(null);
  const [previewState, setPreviewState] = useState<"idle" | "refreshing" | "ready" | "error">("idle");
  const [previewError, setPreviewError] = useState("");
  const [soundPreviewUrl, setSoundPreviewUrl] = useState("");

  function updateInventory(key: keyof Channel["inventory"], value: number) {
    setDraft({ ...draft, inventory: { ...draft.inventory, [key]: value } });
  }
  function updateVideo(key: string, value: string | number | boolean) {
    setDraft({ ...draft, video: { ...draft.video, [key]: value } });
  }
  function updateSceneLock(locked: boolean) {
    setDraft({ ...draft, video: { ...draft.video, limit_scenes: locked } });
  }
  function watermarkOf(): ChannelWatermark {
    const existing: Partial<ChannelWatermark> = draft.video.watermark ?? {};
    return { enabled: existing.enabled ?? false, text: existing.text ?? "", motion: existing.motion ?? "fixed", position: existing.position ?? "bottom_right", opacity: existing.opacity ?? 0.35 };
  }
  function updateWatermark(key: keyof ChannelWatermark, value: string | number | boolean) {
    setDraft({ ...draft, video: { ...draft.video, watermark: { ...watermarkOf(), [key]: value } } });
  }
  function visualMemoryOf(): ChannelVisualMemory {
    const existing: Partial<ChannelVisualMemory> = draft.visual_memory ?? {};
    return { characters: existing.characters ?? [], palette: existing.palette ?? [], composition: existing.composition ?? [], forbidden_elements: existing.forbidden_elements ?? [], exemplars: existing.exemplars ?? [] };
  }
  function updateVisualMemory(key: keyof ChannelVisualMemory, listItems: string) {
    const items = listItems.split("\n").map((item) => item.trim()).filter(Boolean);
    setDraft({ ...draft, visual_memory: { ...visualMemoryOf(), [key]: items } });
  }
  function voicePresetOf(): ChannelVoicePreset {
    const existing: Partial<ChannelVoicePreset> = draft.video.voice_preset ?? {};
    return { voice_id: existing.voice_id ?? String(draft.video.voice_id ?? "zh-CN-YunxiNeural"), tts_speed: existing.tts_speed ?? Number(draft.video.tts_speed ?? 1), voice_volume: existing.voice_volume ?? Number(draft.video.voice_volume ?? 1), bgm_volume: existing.bgm_volume ?? Number(draft.video.bgm_volume ?? 0.18), emotion: existing.emotion ?? "neutral", bgm_path: existing.bgm_path ?? String(draft.video.bgm_path ?? ""), bgm_mode: existing.bgm_mode ?? "loop", intro_path: existing.intro_path ?? "", outro_path: existing.outro_path ?? "", auto_duck: existing.auto_duck ?? true, duck_threshold_db: existing.duck_threshold_db ?? -20, duck_reduction_db: existing.duck_reduction_db ?? 8, loudness_target_lufs: existing.loudness_target_lufs ?? -14 };
  }
  function updateVoicePreset(key: keyof ChannelVoicePreset, value: string | number | boolean) {
    const next = { ...voicePresetOf(), [key]: value };
    setDraft({ ...draft, video: { ...draft.video, voice_preset: next, voice_id: next.voice_id, tts_speed: next.tts_speed, voice_volume: next.voice_volume, bgm_volume: next.bgm_volume, bgm_path: next.bgm_path, bgm_mode: next.bgm_mode } });
  }
  async function previewSound() {
    setBusy("sound-preview"); setError("");
    try { const response = await fetch(`/api/channels/${encodeURIComponent(draft.id)}/sound/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(voicePresetOf()) }); const payload = await response.json(); if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "声音试听生成失败"); setSoundPreviewUrl(payload.url); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "声音试听生成失败"); } finally { setBusy(""); }
  }
  function updateNative(key: string, value: unknown) {
    const native = (draft.video.native as Record<string, unknown> | undefined) || {};
    setDraft({ ...draft, video: { ...draft.video, native: { ...native, [key]: value } } });
  }
  function toggleNativePool(key: "motion_pool" | "transition_pool", value: string) {
    const native = (draft.video.native as Record<string, unknown> | undefined) || {};
    const fallbacks = key === "motion_pool" ? defaultMotionPool : defaultTransitionPool;
    const current = Array.isArray(native[key]) ? native[key] as string[] : fallbacks;
    const next = current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value];
    updateNative(key, next.length ? next : [value]);
  }
  function updateHyperframes(key: string, value: string | number | boolean) {
    const hyperframes = (draft.video.hyperframes as Record<string, unknown> | undefined) || {};
    setDraft({ ...draft, video: { ...draft.video, hyperframes: { ...hyperframes, [key]: value } } });
  }
  function updateWhiteboard(key: string, value: unknown) {
    const whiteboard = (draft.video.whiteboard as Record<string, unknown> | undefined) || {};
    setDraft({ ...draft, video: { ...draft.video, whiteboard: { ...whiteboard, [key]: value } } });
  }
  function bindWhiteboardTemplate(template: WhiteboardTemplate) {
    const whiteboard = (draft.video.whiteboard as Record<string, unknown> | undefined) || {};
    setDraft({
      ...draft,
      video: {
        ...draft.video,
        whiteboard: {
          ...whiteboard,
          template_id: template.template_id,
          template_version: template.version,
          render_profile: template.render_profile,
        },
      },
    });
  }
  function bindTemplate(pack: HyperFramesTemplate) {
    const defaults = Object.fromEntries(Object.entries(pack.variables).map(([name, definition]) => [
      name,
      name === "brand_label" ? draft.name : name === "eyebrow_label" ? "" : definition.default,
    ]));
    const hyperframes = (draft.video.hyperframes as Record<string, unknown> | undefined) || {};
    const sameTemplate = hyperframes.template_id === pack.template_id
      && Number(hyperframes.template_version || 0) === pack.version;
    const existing = (hyperframes.variables as Record<string, unknown> | undefined)
      || (draft.video.template_params as Record<string, unknown> | undefined)
      || {};
    const variables = sameTemplate ? { ...defaults, ...existing } : defaults;
    if (sameTemplate && existing.brand_label === pack.variables.brand_label?.default) variables.brand_label = draft.name;
    if (sameTemplate && existing.eyebrow_label === pack.variables.eyebrow_label?.default) variables.eyebrow_label = "";
    setDraft({ ...draft, video: { ...draft.video, frame_template: pack.native_template, template_params: variables, hyperframes: { ...hyperframes, template_id: pack.template_id, template_version: pack.version, variables } } });
  }
  function updateTemplateVariable(name: string, value: unknown) {
    const hyperframes = (draft.video.hyperframes as Record<string, unknown> | undefined) || {};
    const variables = (hyperframes.variables as Record<string, unknown> | undefined)
      || (draft.video.template_params as Record<string, unknown> | undefined)
      || {};
    const next = { ...variables, [name]: value };
    setDraft({ ...draft, video: { ...draft.video, template_params: next, hyperframes: { ...hyperframes, variables: next } } });
  }
  const productionMode = String(
    draft.video.production_mode
      ?? (draft.video.render_engine === "whiteboard_cv" ? "whiteboard_animation" : draft.video.media_workflow === "api/default/video" ? "direct_video" : "hyperframes"),
  ) as "direct_video" | "hyperframes" | "whiteboard_animation";
  const hyperframesConfig = (draft.video.hyperframes as Record<string, unknown> | undefined) || {};
  const configuredTemplate = templates.find((item) => item.template_id === String(hyperframesConfig.template_id || "") && item.version === Number(hyperframesConfig.template_version || 0));
  const frameTemplate = String(draft.video.frame_template || "");
  const selectedTemplate = configuredTemplate
    ? configuredTemplate.native_template === frameTemplate ? configuredTemplate : undefined
    : templates.find((item) => item.native_template === frameTemplate);
  const templateVariables = useMemo(
    () => (hyperframesConfig.variables as Record<string, unknown> | undefined)
      || (draft.video.template_params as Record<string, unknown> | undefined)
      || {},
    [draft.video.template_params, hyperframesConfig.variables],
  );
  const templatePreviewKey = JSON.stringify({
    templateId: selectedTemplate?.template_id,
    version: selectedTemplate?.version,
    variables: templateVariables,
  });
  useEffect(() => {
    if (!selectedTemplate) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewState("refreshing");
      setPreviewError("");
      try {
        const response = await fetch(
          `/api/template-preview/${encodeURIComponent(selectedTemplate.template_id)}/${selectedTemplate.version}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ variables: templateVariables }),
            signal: controller.signal,
          },
        );
        const result = await response.json();
        if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "实时预览生成失败");
        setLivePreview(result as HyperFramesTemplatePreview);
        setPreviewState("ready");
      } catch (caught) {
        if (controller.signal.aborted) return;
        setPreviewState("error");
        setPreviewError(caught instanceof Error ? caught.message : "实时预览生成失败");
      }
    }, 260);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // templatePreviewKey is the stable serialized contract for the debounced request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templatePreviewKey]);
  const whiteboardConfig = (draft.video.whiteboard as Record<string, unknown> | undefined) || {};
  const whiteboardSettings = {
    template_id: String(whiteboardConfig.template_id || "minimal-whiteboard"),
    template_version: Number(whiteboardConfig.template_version || 1),
    hand_enabled: Boolean(whiteboardConfig.hand_enabled ?? true),
    fallback_policy: String(whiteboardConfig.fallback_policy || "grid"),
    render_profile: (whiteboardConfig.render_profile as Record<string, unknown> | undefined) || {},
  };
  function selectProductionMode(mode: "direct_video" | "hyperframes" | "whiteboard_animation") {
    const direct = mode === "direct_video";
    const hyperframes = mode === "hyperframes";
    const whiteboard = mode === "whiteboard_animation";
    const imageTemplate = configuredTemplate?.native_template || selectedTemplate?.native_template || "1080x1920/f2_knowledge_card_v1.html";
    setDraft({
      ...draft,
      video: {
        ...draft.video,
        production_mode: mode,
        render_engine: whiteboard ? "whiteboard_cv" : hyperframes ? "hyperframes" : "native_image_html",
        renderer_version: whiteboard ? "whiteboard-cv-v1" : hyperframes ? "0.8.4" : "native-image-html-v2",
        media_workflow: direct ? "api/default/video" : "api/default/image",
        frame_template: whiteboard ? "" : direct ? "1080x1920/video_default.html" : imageTemplate,
        whiteboard: {
          template_id: "minimal-whiteboard",
          template_version: 1,
          hand_enabled: true,
          fallback_policy: "grid",
          ...((draft.video.whiteboard as Record<string, unknown> | undefined) || {}),
        },
        hyperframes: {
          quality: "standard",
          strictness: "strict",
          use_gpu: true,
          fallback_to_native: true,
          ...((draft.video.hyperframes as Record<string, unknown> | undefined) || {}),
        },
      },
    });
  }
  function payload() {
    const video = { ...draft.video };
    const hyperframes = { ...((video.hyperframes as Record<string, unknown> | undefined) || {}) };
    const variables = { ...((hyperframes.variables as Record<string, unknown> | undefined) || {}) };
    if (!String(variables.brand_label || "").trim()) variables.brand_label = draft.name;
    if (variables.eyebrow_label == null) variables.eyebrow_label = "";
    hyperframes.variables = variables;
    video.hyperframes = hyperframes;
    video.template_params = variables;
    if (draft.video.limit_scenes) {
      video.n_scenes = Number(draft.video.n_scenes ?? 6);
    } else {
      delete video.n_scenes;
    }
    video.limit_scenes = Boolean(draft.video.limit_scenes);
    return { id: draft.id, name: draft.name, enabled: draft.enabled, topic: draft.topic, inventory: draft.inventory, planning: draft.planning, quality: draft.quality, visual_memory: draft.visual_memory, video };
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy("save"); setError("");
    try {
      const response = await fetch(creating ? "/api/channel-config" : `/api/channel-config/${encodeURIComponent(channel!.id)}`, {
        method: creating ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(channelSaveError(result));
      onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
    finally { setBusy(""); }
  }
  async function testSample() {
    setBusy("test"); setError("");
    try {
      const response = await fetch(`/api/channels/${encodeURIComponent(draft.id)}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "测试样片提交失败");
      setError(`测试样片已进入队列：${result.task_id}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "测试样片提交失败"); }
    finally { setBusy(""); }
  }
  function duplicate() {
    setDraft({ ...draft, id: `${draft.id}_copy`, name: `${draft.name} 副本`, enabled: false });
    setCreating(true);
    setError("已转为副本草稿；修改频道 ID 后保存即可创建。默认保持停用。 ");
  }

  return (
    <div className="editor-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="channel-editor" role="dialog" aria-modal="true" aria-labelledby="channel-editor-title">
        <div className="editor-head"><div><span>{creating ? "CREATE CHANNEL" : draft.id}</span><h2 id="channel-editor-title">{creating ? "新建生产频道" : "频道基础参数"}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭频道设置"><X size={17} /></button></div>
        <form onSubmit={save}>
          <div className="form-grid">
            <label>频道 ID<input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} disabled={!creating} pattern="[a-z0-9][a-z0-9_-]{1,63}" required /></label>
            <label>频道名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
            <label className="toggle-field"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>启用自动生产</span></label>
            <label>选题策略<select value={draft.topic.strategy} onChange={(event) => setDraft({ ...draft, topic: { ...draft.topic, strategy: event.target.value as "seed" | "llm" } })}><option value="llm">Grok 智能选题</option><option value="seed">种子池循环</option></select></label>
            <label>每日目标<input type="number" min="0" max="10000" value={draft.inventory.daily_target} onChange={(event) => updateInventory("daily_target", Number(event.target.value))} /></label>
            <label>库存水位<input type="number" min="0" max="10000" value={draft.inventory.ready_target} onChange={(event) => updateInventory("ready_target", Number(event.target.value))} /></label>
            <label>最大并发<input type="number" min="1" max="1000" value={draft.inventory.max_in_flight} onChange={(event) => updateInventory("max_in_flight", Number(event.target.value))} /></label>
            <div className="scene-limit-control">
              <label className="toggle-field"><input type="checkbox" checked={Boolean(draft.video.limit_scenes)} onChange={(event) => updateSceneLock(event.target.checked)} /><span>限制分镜数量</span></label>
              {draft.video.limit_scenes ? <label>分镜数量<input type="number" min="1" max="20" value={Number(draft.video.n_scenes ?? 6)} onChange={(event) => updateVideo("n_scenes", Number(event.target.value))} /></label> : <p className="scene-limit-hint">AI 自主拆镜：由剧本与内容策略决定分镜数量，不固定上限。</p>}
            </div>
            <label>分镜确认<select value={draft.planning.approval} onChange={(event) => setDraft({ ...draft, planning: { ...draft.planning, enabled: true, approval: event.target.value as "auto" | "manual" } })}><option value="auto">内容门禁通过后自动生成</option><option value="manual">逐条人工确认后生成</option></select></label>
            <label>内容策略<select value={draft.planning.content_policy} onChange={(event) => setDraft({ ...draft, planning: { ...draft.planning, content_policy: event.target.value as "general" | "science" | "psychology" } })}><option value="general">通用安全审校</option><option value="science">科普事实审校</option><option value="psychology">心理措辞审校</option></select></label>
            <label className="toggle-field"><input type="checkbox" checked={draft.quality.auto_repair} onChange={(event) => setDraft({ ...draft, quality: { ...draft.quality, auto_repair: event.target.checked } })} /><span>质检失败后按影响步骤自动修复</span></label>
          </div>
          <fieldset className="production-mode-picker">
            <legend>视频制作方式</legend>
            <div>
              <button type="button" aria-pressed={productionMode === "direct_video"} onClick={() => selectProductionMode("direct_video")}><Film size={18} /><span><strong>原生视频生成</strong><small>视频模型直接生成动态镜头，HTML 叠加字幕与品牌信息</small></span></button>
              <button type="button" aria-pressed={productionMode === "hyperframes"} onClick={() => selectProductionMode("hyperframes")}><Sparkles size={18} /><span><strong>HyperFrames</strong><small>图片与音频本地化后，以确定性时间轴渲染成片</small></span></button>
              <button type="button" aria-pressed={productionMode === "whiteboard_animation"} onClick={() => selectProductionMode("whiteboard_animation")}><PencilLine size={18} /><span><strong>手绘白板动画</strong><small>保留 cs-board 视觉预设，以本地笔迹路径逐步绘制画面</small></span></button>
            </div>
          </fieldset>
          {productionMode === "hyperframes" && templates.length ? <fieldset className="template-pack-picker">
            <legend>版本化画面模板</legend>
            <div className="template-library-head"><div><strong>选择画面语言</strong><span>模板源自真实渲染文件，可安全用于原生 HTML 与 HyperFrames。</span></div><em>{templates.length} 套已发布</em></div>
            <div className="template-preview-grid" role="radiogroup" aria-label="画面模板实际效果">
              {templates.map((pack) => {
                const active = selectedTemplate?.template_id === pack.template_id && selectedTemplate.version === pack.version;
                return <button type="button" role="radio" aria-checked={active} key={`${pack.template_id}@${pack.version}`} onClick={() => bindTemplate(pack)}><span className="template-preview-stage" aria-hidden="true"><iframe tabIndex={-1} sandbox="" srcDoc={pack.preview_html} title={`${pack.display_name}模板预览`} width={pack.preview_width} height={pack.preview_height} /></span><span className="template-preview-meta"><strong>{pack.display_name}</strong><small>{templateCategoryLabel(pack.category)} · V{pack.version}</small><em>{active ? "已选择" : "选择"}</em></span></button>;
              })}
            </div>
            {selectedTemplate ? <div className="template-live-workbench">
              <div className="template-live-preview">
                <div className="template-live-preview-head"><div><strong>{selectedTemplate.display_name}</strong><span>{selectedTemplate.template_id} · V{selectedTemplate.version}</span></div><em role="status" aria-live="polite" data-state={previewState}>{previewState === "refreshing" ? "正在同步变量" : previewState === "error" ? "预览异常" : "实时预览"}</em></div>
                <span className="template-live-stage" aria-busy={previewState === "refreshing"}><iframe tabIndex={-1} sandbox="" srcDoc={livePreview?.template_id === selectedTemplate.template_id && livePreview.version === selectedTemplate.version ? livePreview.preview_html : selectedTemplate.preview_html} title={`${selectedTemplate.display_name}实时模板预览`} width={selectedTemplate.preview_width} height={selectedTemplate.preview_height} /></span>
                <p>{previewError || "颜色、栏目名和透明度变更后约 0.3 秒刷新；展示内容来自真实 HTML 模板。"}</p>
              </div>
              <div className="template-variable-panel"><div className="template-variable-heading"><strong>定制当前模板</strong><span>保存频道时冻结变量与模板指纹</span></div><div className="template-variable-grid">
                {Object.entries(selectedTemplate.variables).map(([name, definition]) => { const value = templateVariables[name] ?? definition.default; return <label key={name}><span>{definition.label}<small>{name}</small></span>{definition.type === "choice" ? <select value={String(value)} onChange={(event) => updateTemplateVariable(name, event.target.value)}>{(definition.choices || []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select> : definition.type === "bool" ? <input type="checkbox" checked={Boolean(value)} onChange={(event) => updateTemplateVariable(name, event.target.checked)} /> : definition.type === "number" ? <span className="template-range-control"><input type="range" min={definition.min} max={definition.max} step="0.01" value={Number(value)} onChange={(event) => updateTemplateVariable(name, Number(event.target.value))} /><output>{Number(value).toFixed(2)}</output></span> : definition.type === "color" ? <span className="template-color-control"><input type="color" value={String(value)} onChange={(event) => updateTemplateVariable(name, event.target.value)} /><code>{String(value).toUpperCase()}</code></span> : <input type="text" value={String(value)} onChange={(event) => updateTemplateVariable(name, event.target.value)} />}</label>; })}
              </div></div>
            </div> : <p className="template-preview-note">请选择一套模板后定制颜色、栏目名称和字幕卡透明度。</p>}
          </fieldset> : null}
          {productionMode === "whiteboard_animation" ? <WhiteboardTemplatePicker templates={whiteboardTemplates} settings={whiteboardSettings} onSelect={bindWhiteboardTemplate} onChange={updateWhiteboard} /> : null}
          <fieldset className="subtitle-effect-picker">
            <legend>字幕特效</legend>
            <div>{subtitleEffects.map((effect) => {
              const selected = String(draft.video.subtitle_effect ?? "static") === effect.id;
              const supportsLayeredSubtitle = productionMode === "direct_video" || productionMode === "whiteboard_animation" || Boolean(selectedTemplate);
              const compatibility = productionMode === "hyperframes" || effect.id === "static"
                ? "当前模式完整支持"
                : !supportsLayeredSubtitle
                  ? "当前模板会降级为静态"
                  : effect.id === "fade_up" ? "当前模式完整支持" : productionMode === "whiteboard_animation" ? "白板模式兼容为淡入上浮" : "原生模式兼容为淡入上浮";
              return <button type="button" key={effect.id} aria-pressed={selected} onClick={() => updateVideo("subtitle_effect", effect.id)}><span className={`subtitle-effect-demo ${effect.id}`}><i>{effect.preview}</i></span><strong>{effect.label}</strong><small>{effect.detail}</small><em>{compatibility}</em></button>;
            })}</div>
          </fieldset>
          <fieldset className="identity-fieldset">
            <legend>频道视觉记忆</legend>
            <p className="identity-fieldset-note">持续沉淀到每一条成片的视觉身份：角色、色调与构图会注入画面提示词与分镜。</p>
            <div className="form-grid">
              <label>角色设定 <small>每行一个</small><textarea value={visualMemoryOf().characters.join("\n")} onChange={(event) => updateVisualMemory("characters", event.target.value)} placeholder="例如：戴圆眼镜的知识讲解员" /></label>
              <label>主色调板 <small>每行一个色值</small><textarea value={visualMemoryOf().palette.join("\n")} onChange={(event) => updateVisualMemory("palette", event.target.value)} placeholder="#D7FF3F" /></label>
              <label>构图规则 <small>每行一条</small><textarea value={visualMemoryOf().composition.join("\n")} onChange={(event) => updateVisualMemory("composition", event.target.value)} placeholder="垂直构图&#10;主体居中&#10;底部留字幕区" /></label>
              <label>禁用元素 <small>每行一个</small><textarea value={visualMemoryOf().forbidden_elements.join("\n")} onChange={(event) => updateVisualMemory("forbidden_elements", event.target.value)} placeholder="例如：真人面孔、品牌 Logo" /></label>
              <label>优秀样片 <small>每行一个路径、URL 或描述</small><textarea value={visualMemoryOf().exemplars.join("\n")} onChange={(event) => updateVisualMemory("exemplars", event.target.value)} placeholder="https://… 或：柔光、铅笔质感" /></label>
            </div>
          </fieldset>
          <fieldset className="identity-fieldset">
            <legend>水印</legend>
            <p className="identity-fieldset-note">关闭时不在成片上叠加水印；开启后按下方参数渲染并随帧保留。</p>
            <div className="form-grid">
              <label className="toggle-field"><input type="checkbox" checked={watermarkOf().enabled} onChange={(event) => updateWatermark("enabled", event.target.checked)} /><span>启用水印</span></label>
              <label>水印状态<select value={watermarkOf().motion} disabled={!watermarkOf().enabled} onChange={(event) => updateWatermark("motion", event.target.value)}><option value="fixed">固定显示</option><option value="moving">缓慢运动</option></select></label>
              <label>水印文本<input value={watermarkOf().text} disabled={!watermarkOf().enabled} onChange={(event) => updateWatermark("text", event.target.value)} placeholder="例如：频道名 / @账号" /></label>
              <label>水印位置<select value={watermarkOf().position} disabled={!watermarkOf().enabled} onChange={(event) => updateWatermark("position", event.target.value)}><option value="top_left">左上</option><option value="top_center">顶部居中</option><option value="top_right">右上</option><option value="center_left">左侧居中</option><option value="center">居中</option><option value="center_right">右侧居中</option><option value="bottom_left">左下</option><option value="bottom_center">底部居中</option><option value="bottom_right">右下</option></select></label>
              <label>透明度<input type="number" min="0" max="1" step="0.05" value={watermarkOf().opacity} disabled={!watermarkOf().enabled} onChange={(event) => updateWatermark("opacity", Number(event.target.value))} /><small>0–1</small></label>
            </div>
          </fieldset>
          <fieldset className="identity-fieldset">
            <legend>声音预设</legend>
            <p className="identity-fieldset-note">旁白声音、配音音量、语速、BGM 音量与情绪会作为频道默认冻结到每条生产任务。</p>
            <div className="form-grid">
              <label>旁白声音<input value={voicePresetOf().voice_id} onChange={(event) => updateVoicePreset("voice_id", event.target.value)} placeholder="zh-CN-YunxiNeural" /></label>
              <label>朗读情绪<select value={voicePresetOf().emotion} onChange={(event) => updateVoicePreset("emotion", event.target.value)}><option value="neutral">中性平稳</option><option value="warm">温暖亲切</option><option value="energetic">活力上扬</option><option value="calm">冷静克制</option><option value="serious">严肃认真</option></select></label>
              <label>语速<input type="number" min="0.5" max="2" step="0.05" value={voicePresetOf().tts_speed} onChange={(event) => updateVoicePreset("tts_speed", Number(event.target.value))} /></label>
              <label>配音音量<input type="number" min="0" max="1.5" step="0.05" value={voicePresetOf().voice_volume} onChange={(event) => updateVoicePreset("voice_volume", Number(event.target.value))} /><small>0–1.5；1.0 为原始音量</small></label>
              <label>BGM 音量<input type="number" min="0" max="1" step="0.01" value={voicePresetOf().bgm_volume} onChange={(event) => updateVoicePreset("bgm_volume", Number(event.target.value))} /></label>
              <label className="wide">BGM 路径<input value={voicePresetOf().bgm_path} onChange={(event) => updateVoicePreset("bgm_path", event.target.value)} placeholder="bgm/default.mp3" /></label>
              <label>播放模式<select value={voicePresetOf().bgm_mode} onChange={(event) => updateVoicePreset("bgm_mode", event.target.value)}><option value="loop">循环铺底</option><option value="once">播放一次</option></select></label>
              <label>响度目标 / LUFS<input type="number" min="-30" max="-9" value={voicePresetOf().loudness_target_lufs} onChange={(event) => updateVoicePreset("loudness_target_lufs", Number(event.target.value))} /></label>
              <label className="wide">片头音效<input value={voicePresetOf().intro_path} onChange={(event) => updateVoicePreset("intro_path", event.target.value)} /></label>
              <label className="wide">片尾音效<input value={voicePresetOf().outro_path} onChange={(event) => updateVoicePreset("outro_path", event.target.value)} /></label>
              <label className="toggle-field"><input type="checkbox" checked={voicePresetOf().auto_duck} onChange={(event) => updateVoicePreset("auto_duck", event.target.checked)} /><span>人声出现时自动闪避 BGM</span></label>
              <label>闪避阈值 / dB<input type="number" min="-60" max="0" value={voicePresetOf().duck_threshold_db} onChange={(event) => updateVoicePreset("duck_threshold_db", Number(event.target.value))} /></label>
              <button type="button" className="secondary" onClick={() => void previewSound()} disabled={creating || !voicePresetOf().bgm_path || Boolean(busy)}>{busy === "sound-preview" ? <LoaderCircle className="spin" size={13} /> : <Volume2 size={13} />}生成 15 秒试听</button>
              {soundPreviewUrl ? <audio controls src={soundPreviewUrl} /> : null}
            </div>
          </fieldset>
          {productionMode === "hyperframes" ? <fieldset className="scene-director-picker">
            <legend>分镜自动导演</legend>
            <div className="form-grid">
              <label>导演策略<select value={String((draft.video.native as Record<string, unknown> | undefined)?.scene_direction ?? "auto")} onChange={(event) => updateNative("scene_direction", event.target.value)}><option value="auto">智能匹配每个分镜</option><option value="fixed">所有分镜使用固定参数</option></select><small>智能模式按旁白、画面提示词和镜头位置选择，并将结果冻结到任务。</small></label>
              <label>默认运镜<select value={String((draft.video.native as Record<string, unknown> | undefined)?.image_motion ?? "ken_burns")} onChange={(event) => updateNative("image_motion", event.target.value)}>{imageMotionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>固定模式直接使用；智能模式作为后备。</small></label>
              <label>默认转场<select value={String((draft.video.native as Record<string, unknown> | undefined)?.transition ?? "crossfade")} onChange={(event) => updateNative("transition", event.target.value)}>{sceneTransitionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label>默认转场秒数<input type="number" min="0.05" max="2" step="0.05" value={Number((draft.video.native as Record<string, unknown> | undefined)?.transition_duration ?? 0.35)} onChange={(event) => updateNative("transition_duration", Number(event.target.value))} /></label>
            </div>
            {String((draft.video.native as Record<string, unknown> | undefined)?.scene_direction ?? "auto") === "auto" ? <div className="direction-pools">
              <DirectionPool title="允许使用的图片运镜" options={imageMotionOptions.filter((option) => option.value !== "none")} selected={Array.isArray((draft.video.native as Record<string, unknown> | undefined)?.motion_pool) ? (draft.video.native as Record<string, unknown>).motion_pool as string[] : defaultMotionPool} onToggle={(value) => toggleNativePool("motion_pool", value)} />
              <DirectionPool title="允许使用的场景转场" options={sceneTransitionOptions.filter((option) => option.value !== "none")} selected={Array.isArray((draft.video.native as Record<string, unknown> | undefined)?.transition_pool) ? (draft.video.native as Record<string, unknown>).transition_pool as string[] : defaultTransitionPool} onToggle={(value) => toggleNativePool("transition_pool", value)} />
            </div> : null}
          </fieldset> : null}
          <label>智能选题提示词<textarea value={draft.topic.prompt} onChange={(event) => setDraft({ ...draft, topic: { ...draft.topic, prompt: event.target.value } })} placeholder="例如：为一分钟天文科普策划一个具体、可视化的选题" /></label>
          <label>后备种子池 <small>每行一个</small><textarea value={draft.topic.seeds.join("\n")} onChange={(event) => setDraft({ ...draft, topic: { ...draft.topic, seeds: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean) } })} required /></label>
          <label>统一画面风格提示词<textarea value={String(draft.video.prompt_prefix ?? "")} onChange={(event) => updateVideo("prompt_prefix", event.target.value)} /></label>
          <details><summary>声音、模板与可靠性参数</summary><div className="form-grid advanced-fields">
            {productionMode !== "direct_video" ? <label>图片生成并发<input type="number" min="1" max="32" value={Number(draft.video.image_generation_concurrency ?? 4)} onChange={(event) => updateVideo("image_generation_concurrency", Number(event.target.value))} /><small>分镜图片将并行提交并逐张落盘；音频、字幕和最终合成仍保持稳定顺序。</small></label> : null}
            {productionMode !== "whiteboard_animation" ? <label>画面模板<input value={String(draft.video.frame_template ?? "")} onChange={(event) => updateVideo("frame_template", event.target.value)} required /></label> : null}
            <label>媒体模型<select value={String(draft.video.media_workflow ?? (productionMode === "direct_video" ? "api/default/video" : "api/default/image"))} onChange={(event) => updateVideo("media_workflow", event.target.value)} required>{productionMode === "direct_video" ? <option value="api/default/video">跟随设置页默认视频模型</option> : <option value="api/default/image">跟随设置页默认图片模型</option>}{draft.video.media_workflow && !["api/default/image", "api/default/video"].includes(String(draft.video.media_workflow)) ? <option value={String(draft.video.media_workflow)}>固定：{String(draft.video.media_workflow)}</option> : null}</select><small>制作方式决定模型能力；新任务会冻结设置页当时的实际模型路由。</small></label>
            {productionMode === "hyperframes" ? <><label>HyperFrames 质量<select value={String((draft.video.hyperframes as Record<string, unknown> | undefined)?.quality ?? "standard")} onChange={(event) => updateHyperframes("quality", event.target.value)}><option value="draft">草稿预览</option><option value="standard">标准</option><option value="high">高质量</option></select></label><label className="toggle-field"><input type="checkbox" checked={Boolean((draft.video.hyperframes as Record<string, unknown> | undefined)?.use_gpu ?? true)} onChange={(event) => updateHyperframes("use_gpu", event.target.checked)} /><span>允许 GPU 渲染</span></label><label className="toggle-field"><input type="checkbox" checked={Boolean((draft.video.hyperframes as Record<string, unknown> | undefined)?.fallback_to_native ?? true)} onChange={(event) => updateHyperframes("fallback_to_native", event.target.checked)} /><span>失败时自动改用原生图片 + HTML</span></label></> : null}
            <label>单轮补货<input type="number" min="1" value={draft.inventory.refill_batch} onChange={(event) => updateInventory("refill_batch", Number(event.target.value))} /></label>
            <label>任务重试<input type="number" min="0" value={draft.inventory.max_task_retries} onChange={(event) => updateInventory("max_task_retries", Number(event.target.value))} /></label>
            <label>熔断阈值<input type="number" min="1" value={draft.inventory.circuit_breaker_failures} onChange={(event) => updateInventory("circuit_breaker_failures", Number(event.target.value))} /></label>
          </div></details>
          {error ? <p className="editor-feedback" role="status">{error}</p> : null}
          <div className="editor-actions">
            {!creating ? <button type="button" className="secondary" onClick={duplicate}><Copy size={14} />复制频道</button> : null}
            {!creating ? <button type="button" className="secondary" onClick={testSample} disabled={Boolean(busy)}>{busy === "test" ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}测试样片</button> : null}
            <button type="submit" disabled={Boolean(busy)}>{busy === "save" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{creating ? "创建频道" : "保存并热加载"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function blankChannel(): Channel {
  return {
    id: "new_channel", name: "新频道", enabled: false, ready: 0, in_flight: 0, failed: 0, published: 0, completed_today: 0, review_pending: 0, approved: 0, rejected: 0, paused: false,
    topic: { strategy: "llm", seeds: ["第一个后备选题"], prompt: "", history_window: 50, fallback_to_seeds: true },
    inventory: { ready_target: 3, daily_target: 1, max_in_flight: 1, refill_batch: 1, max_task_retries: 2, circuit_breaker_failures: 3, failure_cooldown_seconds: 1800 },
    planning: { enabled: true, approval: "auto", content_policy: "general", llm_review: true }, visual_memory: { characters: [], palette: [], composition: [], forbidden_elements: [], exemplars: [] },
    quality: { auto_repair: true },
    video: { mode: "generate", n_scenes: 6, limit_scenes: false, production_mode: "hyperframes", render_engine: "hyperframes", renderer_version: "0.8.4", media_workflow: "api/default/image", frame_template: "1080x1920/f2_knowledge_card_v1.html", subtitle_effect: "static", video_fps: 30, voice_id: "zh-CN-YunxiNeural", tts_speed: 1, voice_volume: 1, bgm_volume: 0.18, prompt_prefix: "Vertical editorial illustration, clean composition, no text, no watermark", native: { image_motion: "ken_burns", transition: "crossfade", transition_duration: 0.35, scene_direction: "auto", motion_pool: defaultMotionPool, transition_pool: defaultTransitionPool }, hyperframes: { template_id: "knowledge-card", template_version: 1, quality: "standard", strictness: "strict", use_gpu: true, fallback_to_native: true }, whiteboard: { template_id: "minimal-whiteboard", template_version: 1, hand_enabled: true, fallback_policy: "grid" }, watermark: { enabled: false, text: "", motion: "fixed", position: "bottom_right", opacity: 0.35 }, voice_preset: { voice_id: "zh-CN-YunxiNeural", tts_speed: 1, voice_volume: 1, bgm_volume: 0.18, emotion: "neutral", bgm_path: "", bgm_mode: "loop", intro_path: "", outro_path: "", auto_duck: true, duck_threshold_db: -20, duck_reduction_db: 8, loudness_target_lufs: -14 } },
  };
}

function JobRow({ job, channelName, mutate, selected, onSelect, onOpenStoryboard, onDeleted }: { job: ProductionJob; channelName: string; mutate: Mutation; selected: boolean; onSelect: () => void; onOpenStoryboard: () => void; onDeleted: (message: string) => void }) {
  const title = job.title || job.topic;
  const output = getOutput(job);
  const active = ["planned", "planning", "submitting", "pending", "running"].includes(job.status);
  return (
    <article className={`job-row ${selected ? "selected" : ""}`}>
      <div className={`status-rail ${job.status}`} />
      <label className="queue-select"><input type="checkbox" checked={selected} onChange={onSelect} /><span className="sr-only">选择任务 {title}</span></label>
      <div className="job-main"><div><span className="job-channel">{channelName}</span><span className={`status-pill ${job.status}`}>{statusLabel[job.status] ?? job.status}</span>{job.status === "ready" ? <span className={`status-pill review-${job.review_status}`}>{reviewLabel[job.review_status]}</span> : null}{job.result?.render_fallback_reason ? <span className="status-pill render-fallback" title={job.result.render_fallback_reason}>原生回退</span> : null}</div><h3>{title}</h3><JobParameterStrip job={job} channelName={channelName} /><p>{job.error || job.review_note || job.topic}</p>{active ? <JobProgress job={job} /> : null}{job.timeline?.length ? <JobEventTimeline job={job} /> : null}</div>
      <div className="job-meta"><span><Clock3 size={13} />{formatTime(job.updated_at)}</span>{job.status === "awaiting_storyboard" ? <button className="text-action storyboard-review-action" onClick={onOpenStoryboard}><BookOpenCheck size={13} />审阅分镜</button> : null}<JobControls job={job} mutate={mutate} onDeleted={onDeleted} compact />{output ? <a href={output} target="_blank" rel="noreferrer">查看成片 <ArrowUpRight size={14} /></a> : null}</div>
    </article>
  );
}

function JobParameterStrip({ job, channelName }: { job: ProductionJob; channelName: string }) {
  const request = job.request || {};
  const mode = String(request.production_mode || (request.render_engine === "native_image_html" ? "direct_video" : "hyperframes"));
  const whiteboard = asRecord(request.whiteboard);
  const hyperframes = asRecord(request.hyperframes);
  const template = mode === "whiteboard_animation"
    ? String(whiteboard.template_id || "默认白板")
    : mode === "hyperframes"
      ? String(hyperframes.template_id || "默认动态图形")
      : String(request.frame_template || "默认画面模板").split("/").at(-1) || "默认画面模板";
  const modeLabel = ({ direct_video: "原生视频", native_image_html: "历史兼容合成", hyperframes: "HyperFrames", whiteboard_animation: "手绘白板" } as Record<string, string>)[mode] || mode;
  const subtitleLabel = ({ static: "静态字幕", fade_up: "淡入上浮", typewriter: "打字机", word_pop: "逐词弹入" } as Record<string, string>)[String(request.subtitle_effect || "static")] || String(request.subtitle_effect || "静态字幕");
  const model = String(request.media_workflow || "未冻结模型").replace(/^api\//, "");
  const concurrency = Number(request.image_generation_concurrency || 4);
  return <div className="job-parameter-strip" aria-label="任务冻结参数">
    <span><small>频道</small><strong>{channelName}</strong></span>
    <span><small>制作</small><strong>{modeLabel}</strong></span>
    <span title={template}><small>视觉</small><strong>{template}</strong></span>
    <span title={String(request.voice_id || "默认声音")}><small>声音</small><strong>{String(request.voice_id || "默认声音")}</strong></span>
    <span><small>字幕</small><strong>{subtitleLabel}</strong></span>
    <span title={model}><small>模型</small><strong>{model}</strong></span>
    {mode !== "direct_video" ? <span><small>图片并发</small><strong>×{concurrency}</strong></span> : null}
  </div>;
}

function JobProgress({ job }: { job: ProductionJob }) {
  const fallback = {
    planned: { percentage: 2, message: "正在准备生产请求" },
    planning: { percentage: 5, message: "等待分镜规划进度" },
    submitting: { percentage: 8, message: "正在提交异步任务" },
    pending: { percentage: 3, message: "已入队，等待执行资源" },
    running: { percentage: 5, message: "任务已启动，等待工序回报" },
  }[job.status] ?? { percentage: 0, message: "等待任务状态" };
  const percentage = Math.max(0, Math.min(100, Math.round(job.progress?.percentage ?? fallback.percentage)));
  const message = job.progress?.message || fallback.message;
  return (
    <div className="job-progress">
      <div className="job-progress-copy"><span><LoaderCircle className="spin" size={11} />CURRENT OPERATION</span><strong>{message}</strong><em>{percentage}%{job.progress?.attempt ? ` · 第 ${job.progress.attempt} 次执行` : ""}</em></div>
      <div className="job-progress-track" role="progressbar" aria-label={`${titleOf(job)}：${message}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage} aria-valuetext={`${percentage}%，${message}`}><span style={{ width: `${percentage}%` }} /></div>
    </div>
  );
}

function JobEventTimeline({ job }: { job: ProductionJob }) {
  return <details className="job-event-timeline"><summary>任务时间线 · {job.timeline?.length} 个事件</summary><div>{job.timeline?.slice(-8).map((event) => <article key={event.id}><i data-status={event.status} /><div><strong>{event.stage} · {event.event_kind}</strong><small>{event.started_at ? formatTime(event.started_at) : "等待开始"}{event.duration_ms != null ? ` · ${(event.duration_ms / 1000).toFixed(1)}s` : ""}{event.model ? ` · ${event.model}` : ""}{event.reuse ? ` · ${event.reuse}` : ""}</small>{event.artifacts?.length ? <p>{event.artifacts.length} 个产物 · {event.artifacts[0]?.path}</p> : null}{event.recovery?.length ? <p>可恢复：{event.recovery.join(" / ")}</p> : null}</div></article>)}</div></details>;
}

function VideoCard({ job, channelName, mutate, onOpen, onDeleted, selected, onSelect }: { job: ProductionJob; channelName: string; mutate: Mutation; onOpen: () => void; onDeleted: (message: string) => void; selected: boolean; onSelect?: () => void }) {
  const output = getOutput(job);
  return (
    <article className={`video-card ${selected ? "selected" : ""}`}>
      <div className="video-stage">
        {output ? <video controls preload="none" playsInline src={output} aria-label={`${job.title || job.topic} 成片预览`} /> : <div className="video-placeholder"><Film size={30} /><span>成片地址不可用</span></div>}
        {onSelect ? <label className="video-select"><input type="checkbox" checked={selected} onChange={onSelect} /><span>{selected ? "已选择" : "选择审核"}</span></label> : null}
        <span className={`review-badge ${job.review_status}`}>{reviewLabel[job.review_status]}</span>
      </div>
      <div className="video-copy"><span>{channelName} · {formatTime(job.completed_at || job.updated_at)}{job.result?.render_fallback_reason ? " · 原生回退" : ""}</span><h3>{job.title || job.topic}</h3><p>{job.review_note || job.topic}</p></div>
      <div className="video-actions"><button className="text-action storyboard-action" onClick={onOpen}><Film size={13} />分镜</button><JobControls job={job} mutate={mutate} onDeleted={onDeleted} />{output ? <a href={output} download aria-label="下载成片"><Download size={15} />下载</a> : null}</div>
    </article>
  );
}

function JobControls({ job, mutate, onDeleted, compact = false }: { job: ProductionJob; mutate: Mutation; onDeleted: (message: string) => void; compact?: boolean }) {
  const [busy, setBusy] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [note, setNote] = useState(job.review_note || "");
  const deleteControl = <DeleteControl resource="job" targetId={job.id} label={`视频「${job.title || job.topic}」`} onDeleted={onDeleted} compact={compact} />;

  async function action(name: string, label: string, body?: object) {
    setBusy(name);
    try {
      await mutate(label, `/api/jobs/${encodeURIComponent(job.id)}/${name}`, body);
      if (name === "reject") setRejecting(false);
      if (name === "cancel") setCancelOpen(false);
    } finally { setBusy(""); }
  }

  if (["planned", "planning", "awaiting_storyboard", "submitting", "pending", "running"].includes(job.status)) {
    return <><div className="review-actions"><button className="text-action danger-action" onClick={() => setCancelOpen(true)} disabled={Boolean(busy)}>{busy ? <LoaderCircle className="spin" size={13} /> : <X size={13} />}取消</button>{deleteControl}</div>{cancelOpen ? <ActionConfirmDialog title={`取消《${job.title || job.topic}》？`} description="任务会停止继续执行，但不会把“取消”误当成“删除”。" consequences={["停止当前规划、排队或生成任务", "保留已经生成的旁白、图片等上游资源", "任务记录仍留在队列，可随后执行永久删除"]} confirmLabel="确认取消任务" busy={busy === "cancel"} onCancel={() => setCancelOpen(false)} onConfirm={() => void action("cancel", "取消任务")} /> : null}</>;
  }
  if (job.status === "failed") {
    return <div className="review-actions"><button className="text-action" onClick={() => action("retry", "重试任务")} disabled={Boolean(busy)}>{busy ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}重试</button>{deleteControl}</div>;
  }
  if (job.status !== "ready" || job.review_status === "approved") return deleteControl;
  if (rejecting && !compact) {
    return (
      <form className="reject-form" onSubmit={(event) => { event.preventDefault(); void action("reject", "驳回成片", { note }); }}>
        <label htmlFor={`note-${job.id}`}>修改意见</label>
        <textarea id={`note-${job.id}`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：第 2 镜字幕遮挡主体" maxLength={2000} autoFocus />
        <div><button type="button" className="text-action" onClick={() => setRejecting(false)}>返回</button><button type="submit" className="text-action danger-action" disabled={!note.trim() || Boolean(busy)}>{busy ? "提交中" : "确认驳回"}</button></div>
      </form>
    );
  }
  return (
    <div className="review-actions">
      <button className="text-action approve-action" onClick={() => action("approve", "审核通过", {})} disabled={Boolean(busy)}><CheckCircle2 size={13} />通过</button>
      {!compact ? <button className="text-action danger-action" onClick={() => setRejecting(true)} disabled={Boolean(busy)}><X size={13} />驳回</button> : null}
      {deleteControl}
    </div>
  );
}

function StoryboardReview({ job, onClose, onChanged }: { job: ProductionJob; onClose: () => void; onChanged: () => void }) {
  const plan = job.storyboard;
  const [title, setTitle] = useState(plan?.title || job.title || job.topic);
  const [scenes, setScenes] = useState<StoryboardScene[]>(() => structuredClone(plan?.scenes || []).map((scene, index) => ({ ...scene, image_motion: scene.image_motion || "ken_burns", transition: scene.transition || (index ? "crossfade" : "none"), transition_duration: scene.transition_duration ?? (index ? 0.35 : 0), direction_reason: scene.direction_reason || "兼容旧分镜参数" })));
  const [checks, setChecks] = useState<ContentCheck[]>(job.content_checks || plan?.content_checks || []);
  const [gate, setGate] = useState(job.content_gate_status || plan?.content_gate_status || "warn");
  const [override, setOverride] = useState(false);
  const [directorNote, setDirectorNote] = useState(plan?.director_note || "");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  function updateScene(index: number, field: keyof StoryboardScene, value: string | number) {
    setScenes((current) => current.map((scene, sceneIndex) => sceneIndex === index ? { ...scene, [field]: value } : scene));
  }

  async function save() {
    setBusy("save"); setFeedback("");
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/storyboard`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, scenes: scenes.map(storyboardScenePayload), director_note: directorNote.trim() || null }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "保存分镜失败");
      setChecks(payload.content_checks || []);
      setGate(payload.content_gate_status || "warn");
      if (payload.storyboard?.title) setTitle(payload.storyboard.title);
      if (payload.storyboard?.scenes) setScenes(payload.storyboard.scenes);
      setFeedback("分镜及导演参数已保存；内容规则已重新检查。 ");
    } catch (caught) { setFeedback(caught instanceof Error ? caught.message : "保存分镜失败"); }
    finally { setBusy(""); }
  }

  async function redirect() {
    setBusy("direct"); setFeedback("");
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/storyboard/redirect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, scenes: scenes.map(storyboardScenePayload), director_note: directorNote.trim() || null }),
      });
      const raw = await response.text();
      let payload: { detail?: unknown };
      try {
        payload = JSON.parse(raw) as { detail?: unknown };
      } catch {
        throw new Error(`重新导演接口返回了非 JSON 响应（HTTP ${response.status}），请重启网页服务后重试`);
      }
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "重新导演任务创建失败");
      onChanged();
    } catch (caught) {
      setFeedback(caught instanceof Error ? caught.message : "重新导演任务创建失败");
      setBusy("");
    }
  }

  async function approve() {
    setBusy("approve"); setFeedback("");
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/storyboard/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ override_content_gate: override }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "确认分镜失败");
      onChanged();
    } catch (caught) { setFeedback(caught instanceof Error ? caught.message : "确认分镜失败"); }
    finally { setBusy(""); }
  }

  return (
    <div className="storyboard-review-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="storyboard-review" role="dialog" aria-modal="true" aria-labelledby="storyboard-review-title">
        <header className="storyboard-review-head">
          <div><span>PRE-GENERATION GATE / {job.channel_id}</span><h2 id="storyboard-review-title">先确认，再消耗视频模型</h2><p>旁白、镜头画面和内容审校通过后，Runner 才会提交 Grok 视频任务。</p></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭分镜确认"><X size={17} /></button>
        </header>
        <div className="storyboard-review-body">
          <div className="storyboard-plan-column">
            <label className="storyboard-title-field">视频标题<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <div className="preflight-scenes">{scenes.map((scene, index) => <article className="preflight-scene" key={index}>
              <div className="preflight-index"><span>{String(index + 1).padStart(2, "0")}</span><small>SCENE</small></div>
              <div><label>旁白<textarea value={scene.narration} onChange={(event) => updateScene(index, "narration", event.target.value)} /></label><label>视觉提示词<textarea value={scene.visual_prompt} onChange={(event) => updateScene(index, "visual_prompt", event.target.value)} /></label><div className="scene-direction-fields"><label>图片运镜<select value={scene.image_motion} onChange={(event) => updateScene(index, "image_motion", event.target.value)}>{imageMotionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>进入转场<select value={scene.transition} disabled={index === 0} onChange={(event) => updateScene(index, "transition", event.target.value)}>{sceneTransitionOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>转场秒数<input type="number" min="0" max="2" step="0.05" value={scene.transition_duration} disabled={index === 0 || scene.transition === "none"} onChange={(event) => updateScene(index, "transition_duration", Number(event.target.value))} /></label><p>{scene.direction_reason || "人工设定"}</p></div></div>
            </article>)}</div>
          </div>
          <aside className="content-gate-column">
            <div className={`content-gate-summary ${gate}`}><ShieldAlert size={19} /><div><span>CONTENT GATE</span><strong>{gate === "pass" ? "内容检查通过" : gate === "fail" ? "存在阻断问题" : "有待确认项"}</strong><p>{checks.filter((check) => check.status === "pass").length} 通过 · {checks.filter((check) => check.status === "warn").length} 注意 · {checks.filter((check) => check.status === "fail").length} 阻断</p></div></div>
            <div className="director-brief"><header><Sparkles size={15} /><div><span>REDIRECT BRIEF</span><strong>智能导演将读取本栏意见</strong></div></header><p>下方所有 CHECK / BLOCK 会自动成为修订依据；只修改被定位的问题镜头，其余镜头原样保留。你也可以补充节奏、措辞或画面要求。</p><label>补充导演意见<textarea value={directorNote} onChange={(event) => setDirectorNote(event.target.value)} placeholder="例如：只修正第 3 镜的事实边界，保留其他镜头。" maxLength={4000} /></label><small>{checks.filter((check) => check.status !== "pass").length} 条审查建议将自动带入</small></div>
            <div className="content-check-list">{checks.map((check) => <article key={check.name} className={`content-check ${check.status}`}><span>{check.status === "pass" ? "PASS" : check.status === "warn" ? "CHECK" : "BLOCK"}</span><strong>{contentCheckName(check.name)}</strong><p>{contentCheckDetail(check.detail)}</p></article>)}</div>
            {gate === "fail" ? <label className="gate-override"><input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} /><span>我已人工核实风险，仍要覆盖阻断并生成</span></label> : null}
          </aside>
        </div>
        {feedback ? <div className="storyboard-feedback" role="status">{feedback}</div> : null}
        <footer className="storyboard-review-actions"><span>{scenes.length} 镜 · 导演参数将在确认后冻结</span><div><button className="secondary review-aware-director" onClick={() => void redirect()} disabled={Boolean(busy) || !title.trim()}>{busy === "direct" ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}按审查建议重新导演</button><button className="secondary" onClick={() => void save()} disabled={Boolean(busy) || !title.trim() || scenes.some((scene) => !scene.narration.trim() || !scene.visual_prompt.trim())}>{busy === "save" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}保存修改</button><button onClick={approve} disabled={Boolean(busy) || (gate === "fail" && !override)}>{busy === "approve" ? <LoaderCircle className="spin" size={14} /> : <BookOpenCheck size={14} />}确认并进入生成</button></div></footer>
      </section>
    </div>
  );
}

function DirectionPool({ title, options, selected, onToggle }: { title: string; options: readonly { value: string; label: string }[]; selected: string[]; onToggle: (value: string) => void }) {
  return <div className="direction-pool"><strong>{title}</strong><div>{options.map((option) => <button type="button" key={option.value} aria-pressed={selected.includes(option.value)} onClick={() => onToggle(option.value)}>{option.label}</button>)}</div></div>;
}

function FilterBar({ values, selected, onSelect, labels }: { values: string[]; selected: string; onSelect: (value: string) => void; labels: Record<string, string> }) {
  return <div className="filters" aria-label="状态筛选">{values.map((value) => <button key={value} className={selected === value ? "active" : ""} onClick={() => onSelect(value)}>{value === "all" ? "全部" : labels[value]}</button>)}</div>;
}

function getOutput(job: ProductionJob) { return job.result?.video_url || job.result?.video_path; }
function titleOf(job: ProductionJob) { return job.title || job.topic; }
function storyboardScenePayload(scene: StoryboardScene) { const { position, ...payload } = scene; void position; return payload; }
function detailOf(payload: { detail?: unknown }, fallback: string) { return typeof payload.detail === "string" ? payload.detail : fallback; }
function channelSaveError(payload: { detail?: unknown }) {
  if (typeof payload.detail === "string") return payload.detail;
  if (payload.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail)) {
    const detail = payload.detail as { message?: unknown; issues?: Array<{ message?: unknown; field?: unknown }> };
    const issues = Array.isArray(detail.issues)
      ? detail.issues.map((item) => `${String(item.field || "配置")}：${String(item.message || "不符合要求")}`).join("；")
      : "";
    return issues || (typeof detail.message === "string" ? detail.message : "频道参数校验失败");
  }
  if (Array.isArray(payload.detail)) {
    return payload.detail.map((item) => {
      const issue = item as { loc?: unknown[]; msg?: unknown };
      return `${issue.loc?.slice(1).join(".") || "配置"}：${String(issue.msg || "不符合要求")}`;
    }).join("；");
  }
  return "频道参数校验失败";
}
function templateCategoryLabel(category: string) { return ({ psychology: "心理", lifestyle: "生活", knowledge: "科普", general: "通用" } as Record<string, string>)[category] || category; }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function contentCheckName(name: string) { return ({ content_structure: "分镜结构", content_prohibited_claims: "过度承诺与禁用表述", content_psychology_language: "心理学措辞安全", content_actionable_advice: "可执行建议", content_fact_boundaries: "事实与推测边界", content_llm_review: "文字模型内容复核" } as Record<string, string>)[name] || name; }
function contentCheckDetail(detail: Record<string, unknown>) { const summary = detail.summary; const route = asRecord(detail.model_route); const routeLabel = [route.channel_name, route.model].filter(Boolean).join(" / "); if (typeof summary === "string") return `${summary}${routeLabel ? ` · ${routeLabel}` : ""}${detail.error ? ` · ${String(detail.error)}` : ""}`; const matches = detail.matches; if (Array.isArray(matches) && matches.length) return `命中：${matches.join("、")}`; return Object.entries(detail).slice(0, 3).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join("、") : String(value)}`).join(" · ") || "未发现问题"; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function Empty({ label }: { label: string }) { return <div className="empty"><Film size={22} /><p>{label}</p></div>; }
