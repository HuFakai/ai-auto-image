"use client";

import { Check, LoaderCircle, SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";

type Preview = { eligible: Array<{ job_id: string; title: string; differences: Array<{ field: string; before: unknown; after: unknown }>; redo_impact: string }>; blocked: Array<{ job_id: string; title: string; reason: string }>; atomic: boolean };
export function BatchParameterReview({ jobIds, onClose, onComplete }: { jobIds: string[]; onClose: () => void; onComplete: (message: string) => void }) {
  const [field, setField] = useState("subtitle_effect"); const [value, setValue] = useState("static");
  const [preview, setPreview] = useState<Preview | null>(null); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  async function call(execute: boolean) {
    setBusy(execute ? "execute" : "preview"); setError("");
    const parsed: unknown = ["tts_speed", "bgm_volume"].includes(field) ? Number(value) : value;
    try {
      const response = await fetch(`/api/jobs/batch/parameters${execute ? "" : "/preview"}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_ids: jobIds, updates: { [field]: parsed } }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "批量参数操作失败");
      if (execute) onComplete(`已更新 ${payload.completed} 条任务参数`); else setPreview(payload);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "批量参数操作失败"); }
    finally { setBusy(""); }
  }
  return <div className="batch-parameter-overlay"><section className="batch-parameter-dialog" role="dialog" aria-modal="true" aria-label="批量参数审阅">
    <header><div><small>DIFF BEFORE WRITE</small><h2>批量参数审阅</h2></div><button onClick={onClose}><X size={15} /></button></header>
    <div className="batch-parameter-form"><label>修改字段<select value={field} onChange={(event) => { setField(event.target.value); setPreview(null); }}><option value="production_mode">制作方式</option><option value="frame_template">模板</option><option value="voice_id">声音</option><option value="tts_speed">语速</option><option value="bgm_volume">BGM 音量</option><option value="subtitle_effect">字幕效果</option><option value="media_workflow">模型路由</option></select></label><label>目标值<input value={value} onChange={(event) => { setValue(event.target.value); setPreview(null); }} /></label><button onClick={() => void call(false)} disabled={Boolean(busy)}>{busy === "preview" ? <LoaderCircle className="spin" size={13} /> : <SlidersHorizontal size={13} />}生成差异预览</button></div>
    {error ? <p className="batch-parameter-error">{error}</p> : null}
    {preview ? <div className="batch-parameter-results"><div><strong>{preview.eligible.length} 条可修改</strong><span>{preview.blocked.length} 条冻结 · 原子执行</span></div>{preview.eligible.map((item) => <article key={item.job_id}><strong>{item.title}</strong><small>影响：{item.redo_impact}</small>{item.differences.map((diff) => <code key={diff.field}>{diff.field}: {JSON.stringify(diff.before)} → {JSON.stringify(diff.after)}</code>)}</article>)}{preview.blocked.map((item) => <article className="blocked" key={item.job_id}><strong>{item.title}</strong><p>{item.reason}</p></article>)}</div> : null}
    <footer><button onClick={onClose}>取消</button><button className="approve" onClick={() => void call(true)} disabled={!preview || Boolean(preview.blocked.length) || Boolean(busy)}>{busy === "execute" ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}确认写入</button></footer>
  </section></div>;
}
