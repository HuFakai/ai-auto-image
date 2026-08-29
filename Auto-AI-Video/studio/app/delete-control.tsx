"use client";

import { AlertTriangle, Check, Copy, LoaderCircle, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { DeletePreview, DeleteResource } from "@/lib/types";
import styles from "./delete-control.module.css";

const countLabels: Record<string, string> = {
  jobs: "生产任务",
  projects: "视频项目",
  revisions: "版本",
  scenes: "镜头",
  artifacts: "素材记录",
  quality_checks: "质检记录",
  restored_topics: "恢复选题",
  topics: "选题",
  sources: "内容源",
  source_items: "采集素材",
  channels: "频道",
  assistant_threads: "制片任务",
  assistant_messages: "对话",
  assistant_plans: "执行计划",
};

export function DeleteControl({ resource, targetId, label, onDeleted, compact = false }: {
  resource: DeleteResource;
  targetId: string;
  label: string;
  onDeleted: (message: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [copyFeedback, setCopyFeedback] = useState("");
  const confirmationRef = useRef<HTMLInputElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !deleting) setOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deleting, open]);

  useEffect(() => () => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
  }, []);

  async function inspect() {
    setOpen(true);
    setLoading(true);
    setPreview(null);
    setError("");
    setConfirmation("");
    setCopyFeedback("");
    try {
      const response = await fetch(
        `/api/delete/${encodeURIComponent(resource)}/${encodeURIComponent(targetId)}`,
        { cache: "no-store" },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(detailOf(result, "无法读取删除影响"));
      setPreview(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法读取删除影响");
    } finally {
      setLoading(false);
    }
  }

  async function copyConfirmation() {
    setConfirmation("删除");
    let copied = false;
    try {
      await navigator.clipboard?.writeText("删除");
      copied = Boolean(navigator.clipboard);
    } catch {
      // Clipboard access can be unavailable on an insecure origin. Filling the
      // confirmation field still completes the requested shortcut.
    }
    setCopyFeedback(copied ? "已复制并填入" : "已填入");
    confirmationRef.current?.focus();
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = setTimeout(() => setCopyFeedback(""), 1800);
  }

  async function remove() {
    if (!preview?.allowed || confirmation !== "删除" || deleting) return;
    setDeleting(true);
    setError("");
    try {
      const response = await fetch(
        `/api/delete/${encodeURIComponent(resource)}/${encodeURIComponent(targetId)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm_id: targetId, delete_files: true }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(detailOf(result, "删除失败"));
      const removed = (result.file_deletion?.files?.length ?? 0) + (result.file_deletion?.directories?.length ?? 0);
      setOpen(false);
      onDeleted(`${label}已永久删除${removed ? `；已清除 ${removed} 个文件或任务目录` : ""}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <button className={`delete-trigger ${compact ? "compact" : ""}`} onClick={() => void inspect()} disabled={deleting} aria-label={`删除${label}`}>
        <Trash2 size={compact ? 12 : 14} />{compact ? <span className="sr-only">删除</span> : "删除"}
      </button>
      {open ? createPortal((
        <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) setOpen(false); }}>
          <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={`delete-title-${targetId}`}>
            <header className={styles.header}>
              <div className={styles.titleBlock}><span>DESTRUCTIVE LEDGER ACTION</span><h2 id={`delete-title-${targetId}`}>删除「{preview?.label || label}」</h2></div>
              <button className={styles.closeButton} onClick={() => setOpen(false)} disabled={deleting} aria-label="关闭删除确认"><X size={17} /></button>
            </header>
            {loading ? <div className={styles.loading}><LoaderCircle className="spin" /><span>正在核对关联数据与文件…</span></div> : null}
            {error ? <p className={styles.error} role="alert"><AlertTriangle size={15} />{error}</p> : null}
            {preview ? (
              <div className={styles.body}>
                <div className={`${styles.verdict} ${preview.allowed ? styles.allowed : styles.blocked}`}>
                  <AlertTriangle size={19} />
                  <div><strong>{preview.allowed ? "永久删除，不可恢复" : "当前不能删除"}</strong><span>{preview.allowed ? "服务端已完成关联检查，相关本地文件会一并清除。" : preview.blocked_reason}</span></div>
                </div>
                <div className={styles.impactGrid}>
                  {Object.entries(preview.counts).filter(([, value]) => value > 0).map(([key, value]) => <div key={key}><strong>{value}</strong><span>{countLabels[key] || key}</span></div>)}
                  {preview.files_count ? <div><strong>{preview.files_count}</strong><span>媒体文件 · {formatBytes(preview.file_bytes)}</span></div> : null}
                </div>
                <div className={styles.consequences}><span>影响范围</span>{preview.consequences.map((item, index) => <p key={item}><i>{String(index + 1).padStart(2, "0")}</i><span>{item}</span></p>)}</div>
                {preview.allowed ? (
                  <>
                    {preview.files_count ? <div className={styles.files}><Trash2 size={16} aria-hidden="true" /><span><strong>永久清除生成媒体</strong><small>对应 output 与 temp 任务目录及其中所有文件将直接删除</small></span></div> : null}
                    <div className={styles.confirmation}>
                      <div className={styles.confirmationPrompt} id={`delete-confirm-${targetId}`}>
                        <span>输入</span>
                        <button type="button" onClick={() => void copyConfirmation()} title="复制并填入“删除”" aria-label="复制并填入删除二字">
                          {copyFeedback ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                          删除
                        </button>
                        <span>继续</span>
                        <span className={styles.copyFeedback} role="status" aria-live="polite">{copyFeedback}</span>
                      </div>
                      <input ref={confirmationRef} aria-labelledby={`delete-confirm-${targetId}`} value={confirmation} onChange={(event) => { setConfirmation(event.target.value); setCopyFeedback(""); }} autoComplete="off" placeholder="删除" />
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
            <footer className={styles.footer}>
              <button className={styles.cancelButton} onClick={() => setOpen(false)} disabled={deleting}>取消</button>
              <button className={styles.submitButton} onClick={() => void remove()} disabled={!preview?.allowed || confirmation !== "删除" || deleting}>{deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}{deleting ? "正在删除…" : "确认删除"}</button>
            </footer>
          </section>
        </div>
      ), document.body) : null}
    </>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function detailOf(payload: { detail?: unknown }, fallback: string): string {
  return typeof payload.detail === "string" ? payload.detail : fallback;
}
