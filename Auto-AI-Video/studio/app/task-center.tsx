"use client";

import { Check, Circle, CircleAlert, ListTodo, LoaderCircle, RefreshCw, RotateCcw, Square, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DurableTask, DurableTaskProgressStepStatus } from "@/lib/types";

const labels: Record<string, string> = {
  video_generation: "视频生成", storyboard_planning: "分镜规划", scene_regeneration: "镜头重做",
  storyboard_redirection: "按审查建议重新导演", quality_repair: "质量修复", revision_render: "版本渲染", source_ingestion: "内容采集",
  custom_script_recommendation: "自定义文案编排",
};

function formatTaskDuration(task: DurableTask, activeTask: boolean) {
  let durationMs = activeTask ? (task.run_duration_ms ?? 0) : task.run_duration_ms ?? null;
  if (task.started_at && (activeTask || durationMs == null)) {
    const startedAt = Date.parse(task.started_at);
    const finishedAt = !activeTask && task.completed_at ? Date.parse(task.completed_at) : Date.now();
    if (Number.isFinite(startedAt) && Number.isFinite(finishedAt)) {
      const currentAttemptMs = Math.max(0, finishedAt - startedAt);
      durationMs = activeTask ? (durationMs ?? 0) + currentAttemptMs : currentAttemptMs;
    }
  }
  if (durationMs == null) return task.status === "pending" ? "等待执行资源" : "执行时间待确认";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const duration = minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
  return activeTask ? `已运行 ${duration}` : `耗时 ${duration}`;
}

function stepIcon(status: DurableTaskProgressStepStatus) {
  if (status === "completed") return <Check size={11} />;
  if (status === "active") return <LoaderCircle className="spin" size={11} />;
  if (status === "failed") return <CircleAlert size={11} />;
  return <Circle size={9} />;
}

function progressLabel(task: DurableTask) {
  const steps = task.progress?.steps ?? [];
  const activeIndex = steps.findIndex((step) => step.status === "active");
  if (activeIndex >= 0) return `第 ${activeIndex + 1}/${steps.length} 步 · ${steps[activeIndex].label}`;
  if (steps.length && task.status === "completed") return `${steps.length} 步已完成`;
  return "当前进度";
}

export function TaskCenter() {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<DurableTask[]>([]);
  const [busy, setBusy] = useState("");
  const poll = useCallback(async () => {
    try {
      const response = await fetch("/api/tasks", { cache: "no-store" });
      if (response.ok) setTasks(await response.json());
    } catch { /* dashboard connectivity owns the global error state */ }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void poll(), 0);
    const timer = window.setInterval(() => void poll(), 5000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [poll]);
  async function action(task: DurableTask, value: "cancel" | "retry") {
    setBusy(`${task.task_id}:${value}`);
    try {
      await fetch(`/api/tasks/${encodeURIComponent(task.task_id)}/${value}`, { method: value === "cancel" ? "DELETE" : "POST" });
      await poll();
    } finally { setBusy(""); }
  }
  const active = tasks.filter((task) => task.status === "pending" || task.status === "running").length;
  return <>
    <button className="task-center-launch" onClick={() => setOpen(true)} aria-label={`后台任务中心，${active} 个活动任务`}><ListTodo size={17} /><span>{active}</span></button>
    {open ? <aside className="task-center-panel" aria-label="后台任务中心">
      <header><div><small>BACKGROUND OPERATIONS</small><h2>后台任务中心</h2></div><button onClick={() => setOpen(false)} aria-label="关闭任务中心"><X size={16} /></button></header>
      <div className="task-center-summary"><span>{active} 个运行中</span><button onClick={() => void poll()}><RefreshCw size={13} />刷新</button></div>
      <div className="task-center-list">{tasks.length ? tasks.slice(0, 80).map((task) => {
        const activeTask = task.status === "pending" || task.status === "running";
        const percentage = Math.max(0, Math.min(100, task.progress?.percentage ?? 0));
        const steps = task.progress?.steps ?? [];
        return <article key={task.task_id} data-status={task.status}>
          <span className="task-center-icon">{activeTask ? <LoaderCircle className="spin" size={14} /> : task.status === "failed" ? <CircleAlert size={14} /> : <ListTodo size={14} />}</span>
          <div>
            <strong>{task.title || labels[task.task_type] || task.task_type}</strong>
            <small>{labels[task.task_type] || task.task_type} · {task.status} · 尝试 {task.attempts}</small>
            <p>{task.error || task.progress?.message || "等待状态更新"}</p>
            {task.progress ? <div className="task-progress">
              <div className="task-progress-meta"><span>{progressLabel(task)}</span><strong>{Math.round(percentage)}%</strong></div>
              <div className={`task-progress-track${activeTask ? " active" : ""}`} role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percentage)}><span style={{ width: `${percentage}%` }} /></div>
              {steps.length ? <ol className="task-progress-steps">{steps.map((step) => <li key={step.id} data-status={step.status}><i>{stepIcon(step.status)}</i><span>{step.label}</span><em>{step.status === "active" ? "进行中" : step.status === "completed" ? "完成" : step.status === "failed" ? "失败" : "待处理"}</em></li>)}</ol> : null}
              <small className="task-duration">{formatTaskDuration(task, activeTask)}</small>
            </div> : null}
          </div>
          <nav>{activeTask ? <button disabled={busy.startsWith(task.task_id)} onClick={() => void action(task, "cancel")} title="取消"><Square size={12} /></button> : null}{task.status === "failed" ? <button disabled={busy.startsWith(task.task_id)} onClick={() => void action(task, "retry")} title="重试"><RotateCcw size={12} /></button> : null}</nav>
        </article>;
      }) : <p className="task-center-empty">暂无后台任务</p>}</div>
    </aside> : null}
  </>;
}
