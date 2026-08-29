"use client";

import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect } from "react";

export function ActionConfirmDialog({ title, description, consequences, confirmLabel, busy, onCancel, onConfirm }: {
  title: string;
  description: string;
  consequences: string[];
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onCancel();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onCancel]);

  return <div className="action-confirm-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="action-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="action-confirm-title" aria-describedby="action-confirm-description">
      <header><span><CircleAlert size={18} /></span><div><small>QUEUE CONTROL / CONFIRM</small><h2 id="action-confirm-title">{title}</h2></div><button className="icon-button" onClick={onCancel} disabled={busy} aria-label="关闭确认窗口"><X size={17} /></button></header>
      <p id="action-confirm-description">{description}</p>
      <ol>{consequences.map((item, index) => <li key={item}><span>{String(index + 1).padStart(2, "0")}</span>{item}</li>)}</ol>
      <footer><button className="secondary" onClick={onCancel} disabled={busy}>返回队列</button><button className="confirm-danger" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <X size={14} />}{confirmLabel}</button></footer>
    </section>
  </div>;
}
