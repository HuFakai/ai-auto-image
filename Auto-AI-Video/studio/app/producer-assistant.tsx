"use client";

import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Command,
  History,
  LoaderCircle,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ProducerAction, ProducerMessage, ProducerPlan, ProducerThread } from "@/lib/types";
import { DeleteControl } from "./delete-control";

type ThreadSummary = Pick<ProducerThread, "id" | "title" | "created_at" | "updated_at" | "message_count">;

const suggestions = [
  "检查最近失败任务，归纳共同原因",
  "比较所有频道的库存与在途任务",
  "检查所有频道的制作方式、画面或白板模板和字幕默认效果",
  "为可编辑草稿分镜推荐字幕效果、关键词和入退场时间",
  "检查草稿分镜的运镜与转场，给出可审批的优化计划",
];

const actionLabel: Record<ProducerAction["action"], string> = {
  create_channel: "创建频道",
  update_channel: "调整频道",
  pause_channel: "暂停频道",
  resume_channel: "恢复频道",
  pin_topic: "钉住选题",
  approve_topic: "通过选题",
  defer_topic: "延后选题",
  discard_topic: "丢弃选题",
  retry_job: "重试任务",
  approve_storyboard: "批准分镜",
  regenerate_scene: "重生成镜头",
  auto_repair_revision: "自动修复质量",
  activate_revision: "设为当前版本",
  set_channel_template: "设置频道画面模板",
  set_channel_whiteboard: "切换白板视觉模板",
  set_channel_subtitle_effect: "设置频道字幕默认效果",
  update_scene_subtitle: "调整逐镜字幕",
  update_scene_direction: "调整逐镜运镜与转场",
};

export function ProducerAssistant({ onClose, onChanged }: {
  onClose: () => void;
  onChanged: (message: string, kind?: "success" | "error") => void;
}) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ProducerMessage[]>([]);
  const [plans, setPlans] = useState<ProducerPlan[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [decisionBusy, setDecisionBusy] = useState("");
  const [error, setError] = useState("");

  const refreshThreads = useCallback(async () => {
    const response = await fetch("/api/assistant/threads", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    setThreads(payload.threads ?? []);
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/assistant/threads", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : { threads: [] })
      .then((payload) => { if (active) setThreads(payload.threads ?? []); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === "Escape" && !busy && !decisionBusy) onClose(); }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, decisionBusy, onClose]);

  async function loadThread(id: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/assistant/threads/${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(detailOf(payload, "读取制片任务失败"));
      setThreadId(payload.id); setMessages(payload.messages ?? []); setPlans(payload.plans ?? []);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "读取制片任务失败"); }
    finally { setBusy(false); }
  }

  function startNew() {
    setThreadId(null); setMessages([]); setPlans([]); setDraft(""); setError("");
  }

  function threadDeleted(message: string, deletedId: string) {
    if (threadId === deletedId) startNew();
    onChanged(message);
    void refreshThreads();
  }

  async function sendMessage(text = draft) {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true); setError(""); setDraft("");
    const optimisticId = `local-${messages.length}`;
    const optimistic: ProducerMessage = {
      id: optimisticId,
      thread_id: threadId ?? "new",
      role: "user",
      content: value,
      payload: {},
      created_at: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    try {
      const response = await fetch("/api/assistant/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: threadId, message: value }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(detailOf(payload, "AI 制片助手暂不可用"));
      setThreadId(payload.thread_id);
      setMessages((current) => [...current, payload.message]);
      if (payload.plan) setPlans((current) => [...current, payload.plan]);
      void refreshThreads();
    } catch (caught) {
      setMessages((current) => current.filter((item) => item.id !== optimisticId));
      setError(caught instanceof Error ? caught.message : "AI 制片助手暂不可用");
    } finally { setBusy(false); }
  }

  async function decide(plan: ProducerPlan, approved: boolean) {
    setDecisionBusy(plan.id); setError("");
    try {
      const response = await fetch(`/api/assistant/plans/${encodeURIComponent(plan.id)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(detailOf(payload, "计划处理失败"));
      setPlans((current) => current.map((item) => item.id === plan.id ? payload : item));
      if (threadId) await loadThread(threadId);
      if (payload.status === "completed") onChanged(`AI 制片计划已完成 ${plan.actions.length} 个操作`);
      else if (payload.status === "rejected") onChanged("AI 制片计划已拒绝，没有修改生产状态");
      else if (payload.status === "failed") {
        const completed = completedActionResults(payload).length;
        onChanged(
          completed ? `AI 制片计划中断，已有 ${completed} 个操作生效；生产数据已刷新` : "AI 制片计划执行失败，没有操作生效",
          "error",
        );
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "计划处理失败"); }
    finally { setDecisionBusy(""); }
  }

  return (
    <div className="producer-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy && !decisionBusy) onClose(); }}>
      <section className="producer-console" role="dialog" aria-modal="true" aria-labelledby="producer-title">
        <aside className="producer-history">
          <div className="producer-history-brand"><Bot size={18} /><span>PIXELLE<br />PRODUCER</span></div>
          <button className="producer-new" onClick={startNew}><Plus size={14} />新制片任务</button>
          <div className="producer-history-label"><History size={12} />历史任务</div>
          <div className="producer-thread-list">
            {threads.map((thread) => <div className={`producer-thread-row ${threadId === thread.id ? "active" : ""}`} key={thread.id}><button onClick={() => loadThread(thread.id)} disabled={busy}><span>{thread.title}</span><small>{thread.message_count ?? 0} 条消息 · {formatTime(thread.updated_at)}</small><ChevronRight size={12} /></button><DeleteControl resource="assistant-thread" targetId={thread.id} label={`制片任务「${thread.title}」`} onDeleted={(message) => threadDeleted(message, thread.id)} compact /></div>)}
            {!threads.length ? <p>第一条制片指令会自动建立审计任务。</p> : null}
          </div>
          <div className="producer-permissions"><ShieldCheck size={14} /><div><strong>APPROVAL GATE ON</strong><span>任何写操作都需要人工批准</span></div></div>
        </aside>

        <div className="producer-main">
          <header className="producer-head">
            <div><span>RESTRICTED TOOL CONSOLE</span><h2 id="producer-title">AI 制片助手</h2></div>
            <button className="icon-button" onClick={onClose} disabled={busy || Boolean(decisionBusy)} aria-label="关闭 AI 制片助手"><X size={17} /></button>
          </header>
          <div className="producer-mobile-threads">
            <button onClick={startNew} disabled={busy}><Plus size={13} />新任务</button>
            <label><History size={13} /><span className="sr-only">选择历史制片任务</span><select value={threadId ?? ""} onChange={(event) => { if (event.target.value) void loadThread(event.target.value); }} disabled={busy}><option value="">历史任务</option>{threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}</select></label>
          </div>

          <div className="producer-stream" aria-live="polite">
            {!messages.length ? <div className="producer-welcome"><Sparkles size={25} /><span>GROK / PRODUCTION CONTROL</span><h3>先观察，再计划。<br />批准后才执行。</h3><p>我可以检查水位与失败、管理频道与选题，也能安全调整画面模板、字幕默认值、逐镜字幕、运镜和转场。所有写操作都会先展示影响，得到批准后才执行。</p><div>{suggestions.map((item) => <button key={item} onClick={() => sendMessage(item)} disabled={busy}>{item}<ChevronRight size={12} /></button>)}</div></div> : null}
            {messages.map((message) => <MessageCard key={message.id} message={message} plans={plans} decisionBusy={decisionBusy} onDecide={decide} />)}
            {busy ? <div className="producer-thinking"><LoaderCircle className="spin" size={15} /><span>正在读取生产账本并约束工具计划…</span></div> : null}
          </div>

          <form className="producer-input" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
            {error ? <p role="alert"><CircleAlert size={13} />{error}</p> : null}
            <label htmlFor="producer-prompt">制片指令</label>
            <textarea id="producer-prompt" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void sendMessage(); } }} placeholder="例如：解释最近失败任务的共同原因；如果需要暂停频道，先给我计划。" maxLength={8000} />
            <div><span><Command size={11} />⌘ Enter 发送</span><button type="submit" disabled={busy || !draft.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}发送给制片助手</button></div>
          </form>
        </div>
      </section>
    </div>
  );
}

function MessageCard({ message, plans, decisionBusy, onDecide }: {
  message: ProducerMessage;
  plans: ProducerPlan[];
  decisionBusy: string;
  onDecide: (plan: ProducerPlan, approved: boolean) => void;
}) {
  const plan = message.payload.plan_id ? plans.find((item) => item.id === message.payload.plan_id) : undefined;
  return (
    <article className={`producer-message ${message.role}`}>
      <header><span>{message.role === "user" ? "YOU / DIRECTIVE" : message.role === "assistant" ? "GROK / PRODUCER" : "SYSTEM / AUDIT"}</span><time>{formatTime(message.created_at)}</time></header>
      <p>{message.content}</p>
      {message.payload.observations?.length ? <div className="producer-observations">{message.payload.observations.map((item, index) => <span key={`${index}-${item}`}><i>{String(index + 1).padStart(2, "0")}</i>{item}</span>)}</div> : null}
      {plan ? <PlanCard plan={plan} busy={decisionBusy === plan.id} onDecide={onDecide} /> : null}
    </article>
  );
}

function PlanCard({ plan, busy, onDecide }: { plan: ProducerPlan; busy: boolean; onDecide: (plan: ProducerPlan, approved: boolean) => void }) {
  const completed = completedActionResults(plan);
  return (
    <section className={`producer-plan ${plan.status}`}>
      <header><div><ShieldCheck size={14} /><span>APPROVAL REQUIRED</span></div><strong>{plan.status.toUpperCase()}</strong></header>
      <div className="producer-action-list">{plan.actions.map((action, index) => <div key={`${action.action}-${action.target_id}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{actionLabel[action.action]} · {action.target_id || "新目标"}</strong><p>{actionDetail(action)}<br />影响：{action.impact}</p><small>{action.rationale} · {action.reversible ? "可人工恢复，但不会自动回滚" : "可能不可逆，需人工处理"}{usesGeneration(action) ? " · 会调用生成模型" : ""}</small></div></div>)}</div>
      {plan.status === "failed" && completed.length ? <p className="producer-plan-error"><strong>部分已执行，不会自动回滚：</strong>{completed.map((item) => `${actionLabel[item.action] ?? item.action} · ${item.target_id || "新目标"}`).join("；")}</p> : null}
      {plan.error ? <p className="producer-plan-error">{plan.error}</p> : null}
      {plan.status === "pending" ? <footer><button onClick={() => onDecide(plan, false)} disabled={busy}><X size={13} />拒绝计划</button><button className="approve" onClick={() => onDecide(plan, true)} disabled={busy}>{busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}批准并执行</button></footer> : <div className="producer-plan-state">{plan.status === "completed" ? <Check size={13} /> : plan.status === "rejected" ? <X size={13} /> : plan.status === "failed" ? <CircleAlert size={13} /> : <LoaderCircle className="spin" size={13} />}{plan.status === "completed" ? "计划已执行" : plan.status === "rejected" ? "计划已拒绝" : plan.status === "failed" ? completed.length ? "执行中断，部分操作已生效" : "执行失败，没有操作生效" : "正在执行"}</div>}
    </section>
  );
}

function usesGeneration(action: ProducerAction): boolean {
  return action.action === "regenerate_scene" || action.action === "auto_repair_revision" || action.action === "retry_job";
}

function actionDetail(action: ProducerAction): string {
  const value = (key: string) => typeof action.params[key] === "string" || typeof action.params[key] === "number" ? String(action.params[key]) : "";
  if (action.action === "set_channel_template") {
    const template = value("template_id") || "当前模板";
    const version = value("template_version");
    const variables = action.params.variables && typeof action.params.variables === "object" ? formatParams(action.params.variables as Record<string, unknown>) : "";
    return `模板：${template}${version ? ` v${version}` : ""}${variables ? ` · 模板变量：${variables}` : ""}`;
  }
  if (action.action === "set_channel_whiteboard") {
    const template = value("template_id") || "极简白板";
    const version = value("template_version");
    return `切换为独立手绘白板动画 · ${template}${version ? ` v${version}` : ""}`;
  }
  if (action.action === "set_channel_subtitle_effect") return `频道默认效果：${subtitleEffectLabel(value("subtitle_effect"))}`;
  if (action.action === "update_scene_subtitle") {
    const effect = action.params.subtitle_effect === null ? "跟随当前版本默认" : value("subtitle_effect") ? subtitleEffectLabel(value("subtitle_effect")) : "保持不变";
    const keywords = Array.isArray(action.params.subtitle_keywords) ? action.params.subtitle_keywords.join("、") || "清空" : "保持不变";
    const start = value("subtitle_start_offset");
    const end = value("subtitle_end_offset");
    return `效果：${effect} · 关键词：${keywords}${start ? ` · 延迟 ${start}s` : ""}${end ? ` · 提前退场 ${end}s` : ""}`;
  }
  if (action.action === "update_scene_direction") {
    return `运镜：${value("image_motion") || "保持不变"} · 转场：${value("transition") || "保持不变"}${value("transition_duration") ? ` / ${value("transition_duration")}s` : ""}`;
  }
  if (action.action === "regenerate_scene") return `范围：${value("scope") || "全部"} · ${action.params.preserve_style === false ? "允许改变风格" : "保持现有风格"}`;
  return Object.keys(action.params).length ? `实际参数：${formatParams(action.params)}` : "无附加参数；执行前会再次核对目标状态与权限门禁";
}

function subtitleEffectLabel(effect: string): string {
  return ({ static: "静态", fade_up: "淡入上浮", typewriter: "打字机", word_pop: "词语弹入" } as Record<string, string>)[effect] || effect || "未指定";
}

function formatParams(params: Record<string, unknown>): string {
  return Object.entries(params).map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value)}`).join("；");
}

function completedActionResults(plan: ProducerPlan): Array<{ action: ProducerAction["action"]; target_id: string }> {
  const actions = plan.result && Array.isArray(plan.result.actions) ? plan.result.actions : [];
  return actions.filter((item): item is { action: ProducerAction["action"]; target_id: string } => Boolean(item) && typeof item === "object" && typeof item.action === "string" && typeof item.target_id === "string");
}

function detailOf(payload: { detail?: unknown }, fallback: string): string {
  return typeof payload.detail === "string" ? payload.detail : fallback;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
