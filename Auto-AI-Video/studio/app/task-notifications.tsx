"use client";

import { BellRing, Check, CircleAlert, Radio, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DurableTask, DurableTaskStatus } from "@/lib/types";

const notificationPreferenceKey = "pixelle.task-notifications.enabled";
const notificationPreferenceEvent = "pixelle-task-notification-preference";
const notificationToastEvent = "pixelle-task-notification-toast";
const terminalStatuses = new Set<DurableTaskStatus>(["completed", "failed", "cancelled"]);
let volatileNotificationPreference: boolean | null = null;
let notificationAudioContext: AudioContext | null = null;

const taskTypeLabel: Record<string, string> = {
  video_generation: "视频生成",
  storyboard_planning: "分镜规划 / 审阅分镜",
  storyboard_regeneration: "分镜重做",
  storyboard_redirection: "AI 重新导演",
  ai_redirection: "AI 重新导演",
  scene_regeneration: "镜头重做 / AI 智能重绘",
  ai_redraw: "AI 智能重绘",
  smart_redraw: "AI 智能重绘",
  custom_script_recommendation: "自定义文案 AI 自动编排",
  quality_repair: "质量修复",
  revision_render: "版本渲染",
  source_ingestion: "内容采集",
};

type NotificationCopy = {
  title: string;
  body: string;
};

type TaskToast = NotificationCopy & {
  id: string;
  kind: "completed" | "failed" | "cancelled" | "test";
};

type SystemDelivery = "requested" | "unsupported" | "blocked" | "unavailable" | "failed";

function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

function notificationsEnabled() {
  if (volatileNotificationPreference !== null) return volatileNotificationPreference;
  try {
    return window.localStorage.getItem(notificationPreferenceKey) === "true";
  } catch {
    return false;
  }
}

function setNotificationsEnabled(enabled: boolean) {
  volatileNotificationPreference = enabled;
  try {
    window.localStorage.setItem(notificationPreferenceKey, String(enabled));
  } catch {
    // The in-memory preference still keeps reminders working in restricted contexts.
  }
  window.dispatchEvent(new CustomEvent(notificationPreferenceEvent, { detail: enabled }));
}

function notificationCopy(task: DurableTask) {
  const type = taskTypeLabel[task.task_type] ?? "后台任务";
  const detail = task.status === "failed"
    ? task.error || task.progress?.message || "请回到生产台检查错误信息"
    : task.status === "cancelled"
      ? "任务已停止，不会继续执行"
      : task.progress?.message || "工作结果已写入生产台";
  const subject = task.title?.trim() || type;
  return {
    title: task.status === "completed" ? "任务已完成" : task.status === "failed" ? "任务执行失败" : "任务已取消",
    body: `${subject} · ${type} · ${detail}`,
  };
}

function showToast(toast: TaskToast) {
  window.dispatchEvent(new CustomEvent<TaskToast>(notificationToastEvent, { detail: toast }));
}

async function ensureNotificationAudioContext() {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  notificationAudioContext ??= new AudioContext();
  if (notificationAudioContext.state === "suspended") {
    await notificationAudioContext.resume();
  }
  return notificationAudioContext;
}

async function playNotificationSound(kind: TaskToast["kind"]) {
  try {
    const context = await ensureNotificationAudioContext();
    if (!context) return;
    const notes = kind === "failed"
      ? [220, 174]
      : kind === "cancelled"
        ? [330]
        : kind === "test"
          ? [523, 659, 784]
          : [659, 880];
    const startedAt = context.currentTime + 0.01;
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteAt = startedAt + index * 0.11;
      oscillator.type = kind === "failed" ? "triangle" : "sine";
      oscillator.frequency.setValueAtTime(frequency, noteAt);
      gain.gain.setValueAtTime(0.0001, noteAt);
      gain.gain.exponentialRampToValueAtTime(0.09, noteAt + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteAt + 0.14);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteAt);
      oscillator.stop(noteAt + 0.16);
    });
  } catch {
    // Browsers may still deny audio before a user gesture; visual reminders remain available.
  }
}

function showSystemNotification(copy: NotificationCopy, tag: string): SystemDelivery {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "unavailable";
  try {
    const notification = new Notification(copy.title, {
      body: copy.body,
      tag,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
    return "requested";
  } catch {
    return "failed";
  }
}

function showTaskNotification(task: DurableTask) {
  if (!notificationsEnabled()) return;
  const copy = notificationCopy(task);
  const transitionKey = `${task.task_id}:${task.attempts}:${task.status}`;
  const kind = task.status === "failed" ? "failed" : task.status === "cancelled" ? "cancelled" : "completed";
  showToast({ ...copy, id: transitionKey, kind });
  void playNotificationSound(kind);
  showSystemNotification(copy, `pixelle-task-${transitionKey}`);
}

export function TaskNotificationMonitor() {
  const statusesRef = useRef(new Map<string, Pick<DurableTask, "status" | "attempts">>());
  const notifiedRef = useRef(new Set<string>());
  const initializedRef = useRef(false);
  const pollingRef = useRef(false);
  const [toasts, setToasts] = useState<TaskToast[]>([]);

  useEffect(() => {
    const receiveToast = (event: Event) => {
      const toast = (event as CustomEvent<TaskToast>).detail;
      if (!toast) return;
      setToasts((current) => [
        ...current.filter((item) => item.id !== toast.id),
        toast,
      ].slice(-4));
    };
    window.addEventListener(notificationToastEvent, receiveToast);
    return () => window.removeEventListener(notificationToastEvent, receiveToast);
  }, []);

  const poll = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      const response = await fetch("/api/tasks", { cache: "no-store" });
      if (!response.ok) return;
      const tasks = await response.json() as DurableTask[];
      const initialized = initializedRef.current;
      const nextStatuses = new Map(statusesRef.current);

      for (const task of tasks) {
        const previous = statusesRef.current.get(task.task_id);
        const reachedTerminal = terminalStatuses.has(task.status)
          && (
            (previous !== undefined && !terminalStatuses.has(previous.status))
            || (previous !== undefined && previous.attempts !== task.attempts)
            || (initialized && previous === undefined)
          );
        const transitionKey = `${task.task_id}:${task.attempts}:${task.status}`;
        if (reachedTerminal && !notifiedRef.current.has(transitionKey)) {
          notifiedRef.current.add(transitionKey);
          showTaskNotification(task);
        }
        nextStatuses.set(task.task_id, { status: task.status, attempts: task.attempts });
      }

      statusesRef.current = nextStatuses;
      if (!initialized) initializedRef.current = true;
    } catch {
      // Dashboard connectivity already reports API failures; notification polling stays quiet.
    } finally {
      pollingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    const pollWhenVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    window.addEventListener("focus", pollWhenVisible);
    window.addEventListener("online", pollWhenVisible);
    document.addEventListener("visibilitychange", pollWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", pollWhenVisible);
      window.removeEventListener("online", pollWhenVisible);
      document.removeEventListener("visibilitychange", pollWhenVisible);
    };
  }, [poll]);

  if (!toasts.length) return null;
  return (
    <aside className="task-notification-toasts" aria-label="任务提醒" aria-live="polite">
      {toasts.map((toast) => (
        <article className={`task-notification-toast ${toast.kind}`} key={toast.id} role={toast.kind === "failed" ? "alert" : "status"}>
          <span className="task-notification-toast-icon"><BellRing size={15} /></span>
          <div><strong>{toast.title}</strong><p>{toast.body}</p></div>
          <button type="button" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} aria-label={`关闭${toast.title}`}><X size={13} /></button>
        </article>
      ))}
    </aside>
  );
}

type PermissionState = NotificationPermission | "unsupported";

export function TaskNotificationSettings() {
  const [permission, setPermission] = useState<PermissionState>("unsupported");
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const initialize = window.setTimeout(() => {
      setPermission(notificationsSupported() ? Notification.permission : "unsupported");
      setEnabled(notificationsEnabled());
    }, 0);

    const syncPreference = (event: Event) => {
      if (event instanceof StorageEvent && event.key === notificationPreferenceKey) {
        volatileNotificationPreference = event.newValue === "true";
      }
      setEnabled(notificationsEnabled());
    };
    const syncPermission = () => setPermission(notificationsSupported() ? Notification.permission : "unsupported");
    window.addEventListener("storage", syncPreference);
    window.addEventListener(notificationPreferenceEvent, syncPreference);
    window.addEventListener("focus", syncPermission);
    return () => {
      window.clearTimeout(initialize);
      window.removeEventListener("storage", syncPreference);
      window.removeEventListener(notificationPreferenceEvent, syncPreference);
      window.removeEventListener("focus", syncPermission);
    };
  }, []);

  async function toggleNotifications() {
    setMessage("");
    if (enabled) {
      setNotificationsEnabled(false);
      setEnabled(false);
      setMessage("任务提醒已关闭");
      return;
    }
    setNotificationsEnabled(true);
    setEnabled(true);
    void ensureNotificationAudioContext();
    if (!notificationsSupported()) {
      setPermission("unsupported");
      setMessage("页面提醒已启用；当前浏览器不支持系统通知");
      return;
    }
    if (Notification.permission === "denied") {
      setPermission("denied");
      setMessage("页面提醒已启用；系统通知被浏览器拦截，可在站点权限中改为允许");
      return;
    }
    let nextPermission: NotificationPermission;
    try {
      nextPermission = Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
    } catch {
      nextPermission = Notification.permission;
    }
    setPermission(nextPermission);
    if (nextPermission === "granted") {
      setMessage("系统与页面提醒均已启用；首次同步不会提醒历史任务");
    } else {
      setMessage("页面提醒已启用；未获得系统通知权限");
    }
  }

  function sendTestNotification() {
    const copy = {
      title: "任务提醒测试",
      body: "Pixelle 会在异步任务完成、失败或取消时提醒你。",
    };
    showToast({ ...copy, id: `test:${Date.now()}`, kind: "test" });
    void playNotificationSound("test");
    const delivery = enabled
      ? showSystemNotification(copy, "pixelle-task-notification-test")
      : "unavailable";
    setMessage(delivery === "requested"
      ? "页面提醒已显示，系统通知也已请求发送"
      : delivery === "blocked"
        ? "页面提醒已显示；系统通知被站点权限拦截"
        : delivery === "unsupported"
          ? "页面提醒已显示；当前浏览器不支持系统通知"
          : delivery === "failed"
            ? "页面提醒已显示；当前环境无法创建系统通知"
            : enabled
              ? "页面提醒已显示；系统通知尚未获授权"
              : "页面提醒已显示；启用提醒后会监听异步任务");
  }

  const state = enabled && permission === "granted" ? "ARMED" : enabled ? "IN-APP" : permission === "unsupported" ? "UNSUPPORTED" : permission === "denied" ? "BLOCKED" : "STANDBY";
  const StateIcon = permission === "denied" || permission === "unsupported" ? CircleAlert : enabled ? Check : Radio;
  const runtimeLabel = enabled && permission === "granted" ? "系统 + 页面" : enabled ? "页面监听中" : permission === "denied" ? "权限受阻" : "未启用";

  return (
    <article className={`notification-runtime-card ${enabled ? "enabled" : ""}`}>
      <div className="runtime-title"><BellRing size={18} /><span><strong>任务完成提醒</strong><small>BROWSER NOTIFICATION</small></span></div>
      <div className="notification-runtime-state"><span><StateIcon size={12} />{state}</span><i>{runtimeLabel}</i></div>
      <p>统一监听视频、分镜、重绘、修复、版本渲染和内容采集等持久任务；系统通知不可用时仍显示页面提醒。</p>
      <div className="notification-runtime-actions">
        <button type="button" onClick={() => void toggleNotifications()}>{enabled ? <X size={13} /> : <BellRing size={13} />}{enabled ? "关闭提醒" : "启用提醒"}</button>
        <button type="button" className="secondary" onClick={sendTestNotification}>测试</button>
      </div>
      {message ? <small className="notification-runtime-message" role="status">{message}</small> : null}
    </article>
  );
}
