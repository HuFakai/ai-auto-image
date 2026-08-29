"use client";

import { AlertTriangle, CheckCircle2, LoaderCircle, X } from "lucide-react";
import { useEffect } from "react";
import styles from "./action-feedback.module.css";

export function ActionFeedback({ message, kind, onDismiss }: {
  message: string;
  kind: "pending" | "success" | "error";
  onDismiss: () => void;
}) {
  const failed = kind === "error";
  const pending = kind === "pending";

  useEffect(() => {
    if (!message || failed || pending) return;
    const timer = window.setTimeout(onDismiss, 4_800);
    return () => window.clearTimeout(timer);
  }, [failed, message, onDismiss, pending]);

  if (!message) return null;
  return (
    <div className={`${styles.toast} ${failed ? styles.failed : pending ? styles.pending : styles.done}`} role={failed ? "alert" : "status"}>
      {failed ? <AlertTriangle size={16} /> : pending ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}
      <div><strong>{failed ? "操作需要处理" : pending ? "正在执行" : "操作已完成"}</strong><span>{message}</span></div>
      <button type="button" onClick={onDismiss} aria-label="关闭操作提示"><X size={13} /></button>
    </div>
  );
}
