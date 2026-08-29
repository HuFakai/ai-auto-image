"use client";

import {
  AlertTriangle,
  AudioLines,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Check,
  Captions,
  ChevronRight,
  CircleCheck,
  CircleX,
  CopyPlus,
  Film,
  GitCompareArrows,
  GripVertical,
  LoaderCircle,
  Lock,
  Merge,
  PencilLine,
  ImagePlay,
  Save,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  TimerReset,
  Unlock,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProductionJob,
  QualityCheck,
  Revision,
  Scene,
  VideoProject,
} from "@/lib/types";
import { DeleteControl } from "./delete-control";

type Tab = "storyboard" | "timeline" | "quality" | "versions";

export function ProjectWorkspace({ job, onClose }: { job: ProductionJob; onClose: () => void }) {
  const [project, setProject] = useState<VideoProject | null>(null);
  const [revisionId, setRevisionId] = useState("");
  const [tab, setTab] = useState<Tab>("storyboard");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [draggedId, setDraggedId] = useState("");
  const [confirmActivate, setConfirmActivate] = useState(false);

  const load = useCallback(async (preferRevision?: string) => {
    const response = await fetch(`/api/project/by-job/${encodeURIComponent(job.id)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "项目载入失败");
    const next = payload as VideoProject;
    setProject(next);
    setRevisionId((current) => preferRevision || current || next.current_revision_id);
  }, [job.id]);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialProject() {
      try {
        const response = await fetch(`/api/project/by-job/${encodeURIComponent(job.id)}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "项目载入失败");
        if (cancelled) return;
        const next = payload as VideoProject;
        setProject(next);
        setRevisionId(next.current_revision_id);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "项目载入失败");
      }
    }

    void loadInitialProject();
    return () => { cancelled = true; };
  }, [job.id]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const revision = useMemo(
    () => project?.revisions.find((item) => item.id === revisionId) || project?.revisions[0],
    [project, revisionId],
  );

  const backgroundWorkActive = useMemo(
    () => Boolean(project?.revisions.some((item) =>
      ["pending", "running"].includes(item.render_status)
      || item.scenes.some((scene) => ["pending", "running"].includes(scene.regeneration_status)))),
    [project],
  );

  useEffect(() => {
    if (!backgroundWorkActive) return;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 2_500);
    return () => window.clearInterval(timer);
  }, [load, backgroundWorkActive]);

  async function mutate(label: string, url: string, options: RequestInit, preferRevision?: string) {
    setBusy(label); setError("");
    try {
      const response = await fetch(url, options);
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : `${label}失败`);
      await load(preferRevision || payload.target_revision_id || (payload.id?.startsWith("revision:") ? payload.id : revision?.id));
    } catch (caught) { setError(caught instanceof Error ? caught.message : `${label}失败`); }
    finally { setBusy(""); }
  }

  async function createDraft() {
    if (!project) return;
    setBusy("创建版本"); setError("");
    try {
      const response = await fetch(`/api/project/${encodeURIComponent(project.id)}/revisions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: `基于 V${revision?.number ?? 1} 的分镜修改` }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload.detail === "string" ? payload.detail : "创建版本失败");
      await load(payload.id);
      setTab("storyboard");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "创建版本失败"); }
    finally { setBusy(""); }
  }

  async function reorder(sceneId: string, direction: -1 | 1) {
    if (!revision) return;
    const index = revision.scenes.findIndex((scene) => scene.id === sceneId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= revision.scenes.length) return;
    const ids = revision.scenes.map((scene) => scene.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await mutate("调整顺序", `/api/project/revisions/${encodeURIComponent(revision.id)}/reorder`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene_ids: ids }) });
  }

  async function dropScene(targetId: string) {
    if (!revision || !draggedId || draggedId === targetId) return;
    const ids = revision.scenes.map((scene) => scene.id);
    const source = ids.indexOf(draggedId);
    const target = ids.indexOf(targetId);
    ids.splice(target, 0, ids.splice(source, 1)[0]);
    setDraggedId("");
    await mutate("调整顺序", `/api/project/revisions/${encodeURIComponent(revision.id)}/reorder`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scene_ids: ids }) });
  }

  function selectRevision(nextRevisionId: string) {
    setConfirmActivate(false);
    setRevisionId(nextRevisionId);
  }

  function reloadAfterDelete(preferRevision?: string) {
    setError("");
    void load(preferRevision).catch((caught) => setError(caught instanceof Error ? caught.message : "删除后刷新失败"));
  }

  const finalVideo = revision?.artifacts.find((artifact) => artifact.kind === "final_video")?.url
    || (revision?.id === project?.current_revision_id ? job.result?.video_url : undefined);

  return (
    <div className="project-overlay" role="presentation">
      <section className="project-workspace" role="dialog" aria-modal="true" aria-labelledby="project-title">
        <header className="project-head">
          <div className="project-identity"><span>{job.channel_id} / PROJECT</span><h2 id="project-title">{project?.title || job.title || job.topic}</h2></div>
          <div className="project-head-actions">{revision ? <span className={`quality-chip ${revision.quality_status}`}><ShieldCheck size={13} />质量 {qualityText(revision.quality_status)}</span> : null}<button className="icon-button" onClick={onClose} aria-label="关闭分镜工作台"><X size={18} /></button></div>
        </header>

        {error ? <div className="workspace-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}
        {!project || !revision ? <div className="workspace-loading"><LoaderCircle className="spin" /><p>正在导入历史分镜并执行技术质检…</p></div> : (
          <div className="project-grid">
            <aside className="preview-column">
              <div className="project-video">{finalVideo ? <video src={finalVideo} controls preload="metadata" playsInline /> : <Film size={34} />}</div>
              <div className="preview-data"><span>CURRENT VIEW</span><strong>V{revision.number} · {revision.status === "active" ? "当前版本" : revision.status === "draft" ? "编辑草稿" : "历史版本"}</strong><p>{revision.note || "由生产任务自动导入"}</p></div>
              <nav className="workspace-tabs" aria-label="项目详情视图">{(["storyboard", "timeline", "quality", "versions"] as Tab[]).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "storyboard" ? "分镜" : value === "timeline" ? "时间线" : value === "quality" ? "质检" : "版本"}<ChevronRight size={13} /></button>)}</nav>
            </aside>

            <div className="workspace-main">
              {tab === "storyboard" ? <Storyboard revision={revision} busy={busy} onReorder={reorder} onDrag={setDraggedId} onDrop={dropScene} onMutate={mutate} onDeleted={() => reloadAfterDelete(revision.id)} /> : null}
              {tab === "timeline" ? <TimelinePanel revision={revision} finalVideo={finalVideo} busy={busy} onMutate={mutate} /> : null}
              {tab === "quality" ? <QualityPanel revision={revision} busy={busy} onRepair={() => mutate("自动修复质检失败项", `/api/project/revisions/${encodeURIComponent(revision.id)}/auto-repair`, { method: "POST" })} /> : null}
              {tab === "versions" ? <VersionPanel project={project} selected={revision.id} busy={busy} onSelect={selectRevision} onMutate={mutate} /> : null}
            </div>

            <aside className="revision-column">
              <div className="rail-heading"><span>REVISION STACK</span><strong>{project.revisions.length} 个版本</strong></div>
              <div className="revision-stack">{project.revisions.map((item) => <button key={item.id} className={item.id === revision.id ? "active" : ""} onClick={() => selectRevision(item.id)}><span>V{item.number}</span><div><strong>{item.status === "active" ? "当前版本" : item.status === "draft" ? "修改草稿" : "历史归档"}</strong><small>{item.scenes.length} 镜 · {qualityText(item.quality_status)}</small></div></button>)}</div>
              <div className="revision-actions">
                {revision.status !== "draft" ? <button onClick={createDraft} disabled={Boolean(busy)}><CopyPlus size={14} />创建可编辑版本</button> : null}
                {revision.status !== "active" ? <><button className={confirmActivate ? "confirming" : "secondary"} onClick={() => { if (!confirmActivate) { setConfirmActivate(true); return; } void mutate("切换版本", `/api/project/${encodeURIComponent(project.id)}/activate/${encodeURIComponent(revision.id)}`, { method: "POST" }, revision.id).finally(() => setConfirmActivate(false)); }} disabled={Boolean(busy)}><ArchiveRestore size={14} />{confirmActivate ? `确认启用 V${revision.number}` : "设为当前版本"}</button>{confirmActivate ? <button className="secondary compact" onClick={() => setConfirmActivate(false)} disabled={Boolean(busy)}><X size={13} />取消</button> : null}</> : null}
                {revision.status !== "active" ? <DeleteControl resource="revision" targetId={revision.id} label={`版本 V${revision.number}`} onDeleted={() => reloadAfterDelete(project.current_revision_id)} /> : null}
              </div>
              <p className="revision-hint">所有修改先进入新 Revision。旧版本保持可回退，原始成片和逐镜素材不会被覆盖。</p>
            </aside>
          </div>
        )}
      </section>
    </div>
  );
}

function Storyboard({ revision, busy, onReorder, onDrag, onDrop, onMutate, onDeleted }: { revision: Revision; busy: string; onReorder: (id: string, direction: -1 | 1) => Promise<void>; onDrag: (id: string) => void; onDrop: (id: string) => Promise<void>; onMutate: (label: string, url: string, options: RequestInit, preferRevision?: string) => Promise<void>; onDeleted: (message: string) => void }) {
  const revisionBusy = revision.scenes.some((scene) => ["pending", "running"].includes(scene.regeneration_status));
  return <section><div className="workspace-section-head"><div><span>SCENE BOARD</span><h3>{revision.scenes.length} 个镜头</h3></div><p>{revisionBusy ? "单镜正在生成并重新拼接；旧素材会保留到任务成功。" : revision.status === "draft" ? "拖动或使用箭头调整顺序；锁定镜头不会被误改。" : "先创建可编辑版本，再修改分镜。"}</p></div><div className="scene-list">{revision.scenes.map((scene, index) => <SceneCard key={`${scene.id}:${scene.updated_at}`} scene={scene} index={index} total={revision.scenes.length} editable={revision.status === "draft"} busy={Boolean(busy) || revisionBusy} nextSceneId={revision.scenes[index + 1]?.id} onMove={onReorder} onDrag={onDrag} onDrop={onDrop} onMutate={onMutate} onDeleted={onDeleted} />)}</div></section>;
}

function SceneCard({ scene, index, total, editable, busy, nextSceneId, onMove, onDrag, onDrop, onMutate, onDeleted }: { scene: Scene; index: number; total: number; editable: boolean; busy: boolean; nextSceneId?: string; onMove: (id: string, direction: -1 | 1) => Promise<void>; onDrag: (id: string) => void; onDrop: (id: string) => Promise<void>; onMutate: (label: string, url: string, options: RequestInit) => Promise<void>; onDeleted: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [directing, setDirecting] = useState(false);
  const [subtitling, setSubtitling] = useState(false);
  const [regenerationScope, setRegenerationScope] = useState<"full" | "visual" | "voice">("full");
  const [preserveStyle, setPreserveStyle] = useState(true);
  const [narration, setNarration] = useState(scene.narration);
  const [prompt, setPrompt] = useState(scene.visual_prompt);
  const [newNarration, setNewNarration] = useState("");
  const [newPrompt, setNewPrompt] = useState(scene.visual_prompt);
  const [motion, setMotion] = useState(scene.image_motion || "none");
  const [transition, setTransition] = useState(index === 0 ? "none" : scene.transition || "none");
  const [transitionDuration, setTransitionDuration] = useState(scene.transition_duration || 0.35);
  const [subtitleEffect, setSubtitleEffect] = useState(scene.subtitle_effect || "inherit");
  const [subtitleKeywords, setSubtitleKeywords] = useState(
    (scene.subtitle_keywords || []).join("，"),
  );
  const [subtitleStartOffset, setSubtitleStartOffset] = useState(
    scene.subtitle_start_offset || 0,
  );
  const [subtitleEndOffset, setSubtitleEndOffset] = useState(
    scene.subtitle_end_offset || 0,
  );
  const media = scene.segment_url || scene.media_url;

  async function sceneMutation(label: string, action: string, body: object, method = "POST") {
    await onMutate(label, `/api/project/scenes/${encodeURIComponent(scene.id)}${action}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setEditing(false);
    setSplitting(false);
    setRegenerating(false);
    setConfirmingMerge(false);
    setDirecting(false);
    setSubtitling(false);
  }

  async function saveDirection() {
    await sceneMutation("保存镜头导演参数", "", {
      image_motion: motion,
      transition: index === 0 ? "none" : transition,
      transition_duration: index === 0 || transition === "none" ? 0 : transitionDuration,
      direction_reason: "创作台分镜卡片人工调整",
    }, "PATCH");
  }

  async function saveSubtitle() {
    const keywords = subtitleKeywords
      .split(/[,，\n]/)
      .map((value) => value.trim())
      .filter((value, position, values) => value && values.indexOf(value) === position)
      .slice(0, 12);
    await sceneMutation("保存逐镜字幕", "", {
      subtitle_effect: subtitleEffect === "inherit" ? null : subtitleEffect,
      subtitle_keywords: keywords,
      subtitle_start_offset: subtitleStartOffset,
      subtitle_end_offset: subtitleEndOffset,
    }, "PATCH");
  }

  const subtitleVisibleDuration = Math.max(
    scene.duration - subtitleStartOffset - subtitleEndOffset,
    0,
  );
  const subtitleTimingValid = scene.duration <= 0 || subtitleVisibleDuration >= 0.1;
  const previewKeywords = subtitleKeywords
    .split(/[,，\n]/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 12);
  const subtitlePreviewMedia = scene.segment_url || scene.media_url;
  const subtitlePreviewIsImage = !scene.segment_url && isImageMediaUrl(scene.media_url);
  const subtitlePreviewElement = !subtitlePreviewMedia
    ? <div className="subtitle-preview-fallback"><Film size={22} /></div>
    : subtitlePreviewIsImage
      // The editor must display task-owned local/media URLs without Next image rewriting.
      // eslint-disable-next-line @next/next/no-img-element
      ? <img src={subtitlePreviewMedia} alt="" />
      : <video src={subtitlePreviewMedia} muted playsInline preload="metadata" />;

  return (
    <article className={`scene-card ${scene.locked ? "locked" : ""} ${["pending", "running"].includes(scene.regeneration_status) ? "regenerating" : ""}`} draggable={editable && !scene.locked && !busy} onDragStart={() => onDrag(scene.id)} onDragOver={(event) => { if (editable) event.preventDefault(); }} onDrop={() => void onDrop(scene.id)}>
      <div className="scene-handle"><GripVertical size={15} /><span>{String(index + 1).padStart(2, "0")}</span></div>
      <div className="scene-thumb" onPointerDown={(event) => event.stopPropagation()} onDragStart={(event) => event.preventDefault()}>{media ? <video src={media} controls preload="metadata" playsInline draggable={false} aria-label={`播放第 ${index + 1} 镜视频`} /> : <Film size={20} />}<span>{scene.duration.toFixed(1)}s</span></div>
      <div className="scene-copy">
        {editing ? <><label>旁白<textarea value={narration} onChange={(event) => setNarration(event.target.value)} /></label><label>视觉提示词<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label></> : <><p className="scene-narration">{scene.narration}</p><p className="scene-prompt">{scene.visual_prompt}</p></>}
        <div className="scene-direction-summary">
          <span><i>运镜</i>{motionLabel(scene.image_motion)}</span>
          <span><i>转场</i>{index === 0 ? "开场直切" : transitionLabel(scene.transition)}</span>
          {editable && !scene.locked ? <button type="button" aria-expanded={directing} onClick={() => setDirecting((value) => !value)} disabled={busy}><SlidersHorizontal size={12} />{directing ? "收起导演参数" : "更换运镜与转场"}</button> : null}
        </div>
        <div className="scene-subtitle-summary">
          <span><Captions size={12} />字幕 {subtitleEffectLabel(scene.subtitle_effect)}</span>
          <span><TimerReset size={12} />{formatSubtitleWindow(scene)}</span>
          {(scene.subtitle_keywords || []).length ? <span className="keyword-summary">强调 {scene.subtitle_keywords.slice(0, 3).join(" / ")}</span> : null}
          {editable && !scene.locked ? <button type="button" aria-expanded={subtitling} onClick={() => setSubtitling((value) => !value)} disabled={busy}><Captions size={12} />{subtitling ? "收起字幕编辑器" : "编辑逐镜字幕"}</button> : null}
        </div>
        {subtitling ? <div className="scene-subtitle-editor">
          <div className="subtitle-safe-preview" aria-label="9 比 16 字幕安全区预览">
            {subtitlePreviewElement}
            <div className="subtitle-safe-guides"><span>字幕安全区</span></div>
            <p className={`subtitle-preview-copy effect-${subtitleEffect === "inherit" ? "static" : subtitleEffect}`}>{highlightedSubtitle(scene.narration, previewKeywords)}</p>
            <small>9:16 · 10% 横向 / 8% 底部安全边距</small>
          </div>
          <div className="subtitle-editor-fields">
            <fieldset>
              <legend>逐镜入场效果</legend>
              <div className="subtitle-effect-compact">{sceneSubtitleEffects.map(([value, label]) => <button type="button" key={value} aria-pressed={subtitleEffect === value} onClick={() => setSubtitleEffect(value)}><i className={`effect-${value === "inherit" ? "static" : value}`}>字</i><span>{label}</span></button>)}</div>
            </fieldset>
            <label>强调关键词 <span>{previewKeywords.length}/12</span><textarea value={subtitleKeywords} onChange={(event) => setSubtitleKeywords(event.target.value)} placeholder="用逗号分隔，例如：情绪，边界感" /></label>
            <div className="subtitle-timing-fields">
              <label>入场延迟 <b>{subtitleStartOffset.toFixed(2)}s</b><input type="range" min="0" max={Math.max(scene.duration - subtitleEndOffset - 0.1, 0)} step="0.05" value={subtitleStartOffset} onChange={(event) => setSubtitleStartOffset(Number(event.target.value))} /></label>
              <label>提前退场 <b>{subtitleEndOffset.toFixed(2)}s</b><input type="range" min="0" max={Math.max(scene.duration - subtitleStartOffset - 0.1, 0)} step="0.05" value={subtitleEndOffset} onChange={(event) => setSubtitleEndOffset(Number(event.target.value))} /></label>
            </div>
            <div className={`subtitle-window-status ${subtitleTimingValid ? "valid" : "invalid"}`}><span>可见窗口</span><strong>{subtitleVisibleDuration.toFixed(2)} 秒</strong><small>{subtitleTimingValid ? "时间基于镜头起点冻结，重试不会漂移。" : "字幕至少需要保留 0.10 秒。"}</small></div>
            {scene.subtitle_effect_fallback_reason ? <p className="subtitle-fallback-note"><AlertTriangle size={12} />{scene.subtitle_effect_fallback_reason}</p> : null}
            <button className="save-subtitle" type="button" onClick={() => void saveSubtitle()} disabled={busy || !subtitleTimingValid || previewKeywords.length > 12}><Save size={13} />保存逐镜字幕</button>
          </div>
        </div> : null}
        {directing ? <div className="scene-direction-editor">
          <label>图片运镜<select value={motion} onChange={(event) => setMotion(event.target.value)}>{timelineMotions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>进入转场<select value={index === 0 ? "none" : transition} onChange={(event) => setTransition(event.target.value)} disabled={index === 0}>{timelineTransitions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label>转场秒数<input type="number" min="0.05" max="2" step="0.05" value={transitionDuration} onChange={(event) => setTransitionDuration(Number(event.target.value))} disabled={index === 0 || transition === "none"} /></label>
          <div className="scene-direction-actions"><span>{index === 0 ? "首镜固定为直接开场。" : "保存后当前草稿会标记为待重新渲染。"}</span><button type="button" onClick={() => void saveDirection()} disabled={busy || (transition !== "none" && (transitionDuration < 0.05 || transitionDuration > 2))}><Save size={12} />保存导演参数</button></div>
        </div> : null}
        {splitting ? <div className="split-fields"><label>新镜头旁白<textarea value={newNarration} onChange={(event) => setNewNarration(event.target.value)} autoFocus /></label><label>新镜头视觉提示词<textarea value={newPrompt} onChange={(event) => setNewPrompt(event.target.value)} /></label></div> : null}
        {regenerating ? <div className="regeneration-panel">
          <div className="regeneration-title"><span>ISOLATED REBUILD</span><strong>只替换第 {index + 1} 镜</strong></div>
          <div className="regeneration-modes" role="group" aria-label="镜头重做范围">
            <button type="button" aria-pressed={regenerationScope === "full"} onClick={() => setRegenerationScope("full")}><WandSparkles size={13} /><span>完整重做<small>配音 + 画面</small></span></button>
            <button type="button" aria-pressed={regenerationScope === "visual"} onClick={() => setRegenerationScope("visual")}><ImagePlay size={13} /><span>只换画面<small>保留现有配音</small></span></button>
            <button type="button" aria-pressed={regenerationScope === "voice"} onClick={() => setRegenerationScope("voice")}><AudioLines size={13} /><span>只换配音<small>保留现有画面</small></span></button>
          </div>
          {regenerationScope !== "voice" ? <label className="style-lock"><input type="checkbox" checked={preserveStyle} onChange={(event) => setPreserveStyle(event.target.checked)} /><span>引用当前镜头首帧，尽量保持角色与画风</span></label> : null}
          <div className="regeneration-submit"><button type="button" onClick={() => setRegenerating(false)}>取消</button><button type="button" className="primary" onClick={() => void sceneMutation("提交单镜重做", "/regenerate", { scope: regenerationScope, preserve_style: preserveStyle })}><WandSparkles size={13} />开始异步重做</button></div>
        </div> : null}
        {["pending", "running"].includes(scene.regeneration_status) ? <div className="regeneration-status"><LoaderCircle className="spin" size={14} /><div><strong>{scene.regeneration_status === "pending" ? "等待生成资源" : "正在重做并局部拼接"}</strong><span>{scopeText(scene.regeneration_scope)} · 成功前继续使用旧镜头</span></div></div> : null}
        {scene.regeneration_status === "failed" ? <div className="regeneration-status failed" role="alert"><AlertTriangle size={14} /><div><strong>单镜重做失败，旧素材未变</strong><span>{scene.regeneration_error || "请检查上游或媒体合成日志后重试"}</span></div></div> : null}
        {scene.regeneration_status === "completed" && scene.regenerated_at ? <div className="regenerated-note"><CircleCheck size={12} />已局部重做并重新质检</div> : null}
      </div>
      <div className="scene-controls">
        {editable ? <>
          <button aria-label="上移镜头" disabled={index === 0 || busy} onClick={() => void onMove(scene.id, -1)}><ArrowUp size={13} /></button>
          <button aria-label="下移镜头" disabled={index === total - 1 || busy} onClick={() => void onMove(scene.id, 1)}><ArrowDown size={13} /></button>
          <button aria-label={scene.locked ? "解锁镜头" : "锁定镜头"} onClick={() => void sceneMutation(scene.locked ? "解锁镜头" : "锁定镜头", "", { locked: !scene.locked }, "PATCH")} disabled={busy}>{scene.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
          {!scene.locked ? <>
            {editing ? <button className="positive" aria-label="保存镜头" onClick={() => void sceneMutation("保存镜头", "", { narration, visual_prompt: prompt }, "PATCH")} disabled={!narration.trim() || !prompt.trim() || busy}><Save size={13} /></button> : <button onClick={() => setEditing(true)} aria-label="编辑镜头"><Film size={13} /></button>}
            <button className="regenerate-control" aria-label="重做镜头" onClick={() => setRegenerating((value) => !value)} disabled={busy}><WandSparkles size={13} /></button>
            <button aria-label="拆分镜头" onClick={() => setSplitting((value) => !value)}><Scissors size={13} /></button>
            {nextSceneId ? <><button className={confirmingMerge ? "warning" : ""} aria-label={confirmingMerge ? "确认与下一镜合并" : "与下一镜合并"} onClick={() => { if (!confirmingMerge) { setConfirmingMerge(true); return; } void sceneMutation("合并镜头", "/merge", { next_scene_id: nextSceneId }); }}><Merge size={13} /></button>{confirmingMerge ? <button aria-label="取消合并" onClick={() => setConfirmingMerge(false)}><X size={13} /></button> : null}</> : null}
            <DeleteControl resource="scene" targetId={scene.id} label={`第 ${index + 1} 镜`} onDeleted={onDeleted} compact />
          </> : null}
        </> : null}
        {splitting ? <button className="positive wide" onClick={() => void sceneMutation("拆分镜头", "/split", { narration: newNarration, visual_prompt: newPrompt })} disabled={!newNarration.trim() || !newPrompt.trim() || busy}><Check size={13} />确认拆分</button> : null}
      </div>
    </article>
  );
}

const timelineMotions = [
  ["none", "静止"], ["push_in", "推进"], ["pull_out", "拉远"],
  ["pan_left", "向左平移"], ["pan_right", "向右平移"],
  ["pan_up", "向上平移"], ["pan_down", "向下平移"], ["ken_burns", "复合运镜"],
];
const timelineTransitions = [
  ["none", "直接切换"], ["crossfade", "交叉淡化"], ["dissolve", "溶解"],
  ["slide_left", "左滑"], ["slide_right", "右滑"], ["wipe_up", "上擦除"],
  ["wipe_down", "下擦除"], ["circle_open", "圆形展开"], ["zoom_in", "缩放进入"],
  ["fade_black", "淡黑"], ["blur", "模糊过渡"],
];
const sceneSubtitleEffects = [
  ["inherit", "版本默认"],
  ["static", "静态"],
  ["fade_up", "淡入上浮"],
  ["typewriter", "打字机"],
  ["word_pop", "词语弹入"],
] as const;

function TimelinePanel({ revision, finalVideo, busy, onMutate }: { revision: Revision; finalVideo?: string; busy: string; onMutate: (label: string, url: string, options: RequestInit) => Promise<void> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const totalDuration = Math.max(revision.scenes.reduce((sum, scene) => sum + Math.max(scene.duration, 0), 0), 0.1);
  const [currentTime, setCurrentTime] = useState(0);
  const activeIndex = useMemo(() => {
    let cursor = 0;
    for (let index = 0; index < revision.scenes.length; index += 1) {
      cursor += Math.max(revision.scenes[index].duration, 0);
      if (currentTime < cursor || index === revision.scenes.length - 1) return index;
    }
    return 0;
  }, [currentTime, revision.scenes]);
  const scene = revision.scenes[activeIndex];
  const defaults = {
    sceneId: scene?.id || "", focusX: scene?.focus_x ?? 0.5, focusY: scene?.focus_y ?? 0.5,
    motion: scene?.image_motion || "none", transition: scene?.transition || "none",
    transitionDuration: scene?.transition_duration ?? 0.35,
  };
  const [editor, setEditor] = useState(defaults);
  const activeEditor = editor.sceneId === scene?.id ? editor : defaults;
  const { focusX, focusY, motion, transition, transitionDuration } = activeEditor;
  const setFocusX = (value: number) => setEditor({ ...activeEditor, focusX: value });
  const setFocusY = (value: number) => setEditor({ ...activeEditor, focusY: value });
  const setMotion = (value: string) => setEditor({ ...activeEditor, motion: value });
  const setTransition = (value: string) => setEditor({ ...activeEditor, transition: value });
  const setTransitionDuration = (value: number) => setEditor({ ...activeEditor, transitionDuration: value });

  function seek(time: number) {
    const next = Math.min(Math.max(time, 0), totalDuration);
    setCurrentTime(next);
    if (videoRef.current) videoRef.current.currentTime = next;
  }

  function sceneStart(index: number) {
    return revision.scenes.slice(0, index).reduce((sum, item) => sum + Math.max(item.duration, 0), 0);
  }

  async function saveKeyframes() {
    if (!scene) return;
    await onMutate("保存镜头关键帧", `/api/project/scenes/${encodeURIComponent(scene.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        focus_x: Number(focusX.toFixed(4)), focus_y: Number(focusY.toFixed(4)),
        focus_confidence: 1, focus_source: "studio_manual",
        image_motion: motion,
        transition: activeIndex === 0 ? "none" : transition,
        transition_duration: activeIndex === 0 || transition === "none" ? 0 : transitionDuration,
        direction_reason: "创作台时间线人工调整",
      }),
    });
  }

  if (!scene) return <section className="timeline-empty"><Film /><p>当前版本没有可预览镜头。</p></section>;
  const preview = finalVideo || scene.segment_url || scene.media_url;
  const poses = motionPose(motion, focusX, focusY);
  return <section className="timeline-panel">
    <div className="workspace-section-head"><div><span>SEEKABLE TIMELINE</span><h3>成片时间线与关键帧</h3></div><p>{formatTime(currentTime)} / {formatTime(totalDuration)} · 当前第 {activeIndex + 1} 镜</p></div>
    <div className="timeline-preview-shell">
      <div className="timeline-video-stage">
        {preview ? <video ref={videoRef} src={preview} controls preload="metadata" playsInline onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} /> : <Film size={30} />}
        <span className="focus-reticle" style={{ left: `${focusX * 100}%`, top: `${focusY * 100}%` }} aria-label={`主体焦点 ${Math.round(focusX * 100)}%, ${Math.round(focusY * 100)}%`}><i /></span>
        <div className="timeline-stage-meta"><span>SCENE {String(activeIndex + 1).padStart(2, "0")}</span><strong>{motionLabel(motion)}</strong></div>
      </div>
      <div className="timeline-scene-copy"><span>当前镜头旁白</span><p>{scene.narration}</p><small>{scene.focus_source === "studio_manual" ? "人工焦点" : scene.focus_source ? `自动焦点 · 置信度 ${Math.round((scene.focus_confidence || 0) * 100)}%` : "旧素材 · 中心焦点"}</small></div>
    </div>
    <div className="timeline-ruler" aria-label="镜头时间线">
      <div className="timeline-playhead" style={{ left: `${Math.min(currentTime / totalDuration * 100, 100)}%` }}><span>{formatTime(currentTime)}</span></div>
      <div className="timeline-track">{revision.scenes.map((item, index) => <button key={item.id} className={index === activeIndex ? "active" : ""} style={{ flexGrow: Math.max(item.duration, 0.2) }} onClick={() => seek(sceneStart(index))}><strong>{String(index + 1).padStart(2, "0")}</strong><span>{item.duration.toFixed(1)}s</span><small>{motionLabel(item.image_motion)}</small></button>)}</div>
      <input aria-label="时间线播放头" type="range" min="0" max={totalDuration} step="0.01" value={Math.min(currentTime, totalDuration)} onChange={(event) => seek(Number(event.target.value))} />
    </div>
    <div className="keyframe-editor">
      <div className="keyframe-rail"><header><span>CAMERA POSE</span><strong>{motionLabel(motion)}</strong></header><div className="pose-line"><article><span>IN · 0%</span><strong>{poses[0]}</strong></article><i /><article><span>OUT · 100%</span><strong>{poses[1]}</strong></article></div></div>
      <div className="keyframe-fields">
        <label>运镜方式<select value={motion} onChange={(event) => setMotion(event.target.value)} disabled={revision.status !== "draft"}>{timelineMotions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>进入转场<select value={activeIndex === 0 ? "none" : transition} onChange={(event) => setTransition(event.target.value)} disabled={revision.status !== "draft" || activeIndex === 0}>{timelineTransitions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>转场秒数<input type="number" min="0.05" max="2" step="0.05" value={transitionDuration} onChange={(event) => setTransitionDuration(Number(event.target.value))} disabled={revision.status !== "draft" || activeIndex === 0 || transition === "none"} /></label>
        <label>主体横向焦点 <b>{Math.round(focusX * 100)}%</b><input type="range" min="0" max="1" step="0.01" value={focusX} onChange={(event) => setFocusX(Number(event.target.value))} disabled={revision.status !== "draft"} /></label>
        <label>主体纵向焦点 <b>{Math.round(focusY * 100)}%</b><input type="range" min="0" max="1" step="0.01" value={focusY} onChange={(event) => setFocusY(Number(event.target.value))} disabled={revision.status !== "draft"} /></label>
        {revision.status === "draft" ? <button className="save-keyframes" onClick={() => void saveKeyframes()} disabled={Boolean(busy)}><Save size={14} />保存焦点与关键帧</button> : <p className="keyframe-readonly"><Lock size={13} />创建草稿版本后可调整</p>}
      </div>
    </div>
  </section>;
}

function QualityPanel({ revision, busy, onRepair }: { revision: Revision; busy: string; onRepair: () => Promise<void> }) {
  const summary = revision.quality_checks.reduce((counts, check) => ({ ...counts, [check.status]: counts[check.status] + 1 }), { pass: 0, warn: 0, fail: 0 });
  const repairStatus = revision.repair_status || "idle";
  const repairActive = ["planned", "pending", "running"].includes(repairStatus);
  return <section>
    <div className="workspace-section-head"><div><span>AUTOMATIC GATE</span><h3>技术质量报告</h3></div><p>{summary.pass} 通过 · {summary.warn} 警告 · {summary.fail} 失败</p></div>
    <HyperFramesCheckReport revision={revision} />
    {repairStatus !== "idle" ? <div className={`quality-repair-banner ${repairStatus}`}><WandSparkles size={16} /><div><strong>{repairActive ? "正在按影响步骤自动修复" : repairStatus === "completed" ? "自动修复已完成，可检查草稿版本" : "自动修复未完成"}</strong><span>{repairPlanText(revision)}{revision.repair_error ? ` · ${revision.repair_error}` : ""}</span></div></div> : null}
    {summary.fail > 0 && revision.status === "active" && !repairActive && repairStatus !== "completed" ? <button className="quality-repair-action" onClick={() => void onRepair()} disabled={Boolean(busy)}>{busy === "自动修复质检失败项" ? <LoaderCircle className="spin" size={14} /> : <WandSparkles size={14} />}仅修复失败项</button> : null}
    <div className="quality-list">{revision.quality_checks.length ? revision.quality_checks.map((check) => <QualityRow key={check.id} check={check} />) : <div className="quality-empty"><ShieldCheck /><p>此草稿已发生修改，需重新渲染后执行质量检查。</p></div>}</div>
  </section>;
}

type HyperFramesCheckSection = { ok?: boolean; errorCount?: number; warningCount?: number; infoCount?: number; findings?: Array<Record<string, unknown>>; checked?: number; passed?: number; samples?: unknown[] };
type HyperFramesCheck = { ok?: boolean; strict?: boolean; lint?: HyperFramesCheckSection; runtime?: HyperFramesCheckSection; layout?: HyperFramesCheckSection; motion?: HyperFramesCheckSection; contrast?: HyperFramesCheckSection; _meta?: { version?: string }; _pixelle?: { checked_at?: string; strictness?: string } };

function HyperFramesCheckReport({ revision }: { revision: Revision }) {
  const artifact = revision.artifacts.find((item) => item.kind === "check_report");
  if (!artifact) return null;
  return <HyperFramesCheckReportLoader key={artifact.url} artifactUrl={artifact.url} />;
}

function HyperFramesCheckReportLoader({ artifactUrl }: { artifactUrl: string }) {
  const [report, setReport] = useState<HyperFramesCheck | null>(null);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void fetch(artifactUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("检查报告文件不可读取");
      const payload = await response.json() as HyperFramesCheck;
      if (!cancelled) { setReport(payload); setLoadError(""); }
    }).catch((caught) => { if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "检查报告载入失败"); });
    return () => { cancelled = true; };
  }, [artifactUrl]);
  if (loadError) return <div className="hf-report-error"><AlertTriangle size={14} />HyperFrames 报告：{loadError}</div>;
  if (!report) return <div className="hf-report-loading"><LoaderCircle className="spin" size={14} />读取 HyperFrames 检查报告…</div>;
  const sections = (["lint", "runtime", "layout", "motion", "contrast"] as const).map((name) => ({ name, value: report[name] || {} }));
  const findings = sections.flatMap(({ name, value }) => (value.findings || []).map((finding) => ({ section: name, finding })));
  return <div className={`hf-report ${report.ok ? "pass" : "fail"}`}>
    <header><div><span>HYPERFRAMES CHECK · {report._meta?.version || "UNKNOWN"}</span><strong>{report.ok ? "严格检查通过" : "存在渲染风险"}</strong></div><span>{report.strict ? "STRICT" : "STANDARD"}</span></header>
    <div className="hf-report-grid">{sections.map(({ name, value }) => <article key={name} className={value.ok === false ? "fail" : "pass"}><span>{name.toUpperCase()}</span><strong>{value.ok === false ? "失败" : "通过"}</strong><small>{value.errorCount || 0} 错误 · {value.warningCount || 0} 警告{typeof value.checked === "number" ? ` · ${value.passed || 0}/${value.checked}` : ""}</small></article>)}</div>
    {findings.length ? <div className="hf-findings">{findings.map(({ section, finding }, index) => <p key={`${String(section)}:${index}`}><AlertTriangle size={12} /><b>{String(section).toUpperCase()}</b>{String(finding.message || finding.detail || finding.code || "未命名问题")}</p>)}</div> : <p className="hf-clean"><CircleCheck size={13} />布局、运行时、对比度与时间线检查没有发现问题。</p>}
  </div>;
}

function QualityRow({ check }: { check: QualityCheck }) {
  const Icon = check.status === "pass" ? CircleCheck : check.status === "fail" ? CircleX : AlertTriangle;
  return <article className={`quality-row ${check.status}`}><Icon size={18} /><div><strong>{checkName(check.check_name)}</strong><p>{detailText(check.detail)}</p></div><span>{check.status === "pass" ? "通过" : check.status === "fail" ? "失败" : "注意"}</span></article>;
}

function VersionPanel({ project, selected, busy, onSelect, onMutate }: { project: VideoProject; selected: string; busy: string; onSelect: (id: string) => void; onMutate: (label: string, url: string, options: RequestInit, preferRevision?: string) => Promise<void> }) {
  const revision = project.revisions.find((item) => item.id === selected) || project.revisions[0];
  const baseline = project.revisions.find((item) => item.id === revision.parent_revision_id)
    || [...project.revisions].filter((item) => item.number < revision.number).sort((a, b) => b.number - a.number)[0];
  const total = Math.max(revision.scenes.length, baseline?.scenes.length || 0);
  const changes = Array.from({ length: total }, (_, index) => compareScene(baseline?.scenes[index], revision.scenes[index], index));
  const changed = changes.filter((item) => item.status !== "same").length;
  const sameAssets = baseline ? rendererAssetsMatch(baseline, revision) : false;
  const baselineVideo = baseline?.artifacts.find((artifact) => artifact.kind === "final_video")?.url;
  const revisionVideo = revision.artifacts.find((artifact) => artifact.kind === "final_video")?.url;
  const renderActive = ["planned", "pending", "running"].includes(revision.render_status);
  const renderVariant = (engine: "hyperframes" | "whiteboard_cv") => onMutate(
    engine === "hyperframes" ? "生成 HyperFrames 对照" : "生成白板对照",
    `/api/project/revisions/${encodeURIComponent(revision.id)}/render-variant`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ engine }) },
  );
  return <section>
    <div className="workspace-section-head"><div><span>REVISION DIFF</span><h3>V{revision.number} 版本差异</h3></div><p>{baseline ? `对比父版本 V${baseline.number}：${changed} 个镜头发生变化。` : "初始版本没有可比较的父版本。"}</p></div>
    <div className="renderer-lab"><div><span>RENDERER LAB / SAME ASSETS</span><strong>同一套图片与旁白，比较两种合成方式</strong><p>这里只重做合成，不会重新生图或重新配音；每个版本都独立保留。</p></div><div className="renderer-lab-actions"><button onClick={() => void renderVariant("hyperframes")} disabled={Boolean(busy) || renderActive}><WandSparkles size={14} />生成 HyperFrames 对照</button><button onClick={() => void renderVariant("whiteboard_cv")} disabled={Boolean(busy) || renderActive}><PencilLine size={14} />生成白板对照</button></div></div>
    {revision.render_status !== "idle" ? <div className={`renderer-status ${revision.render_status}`}><span>{rendererLabel(revision.render_engine)}</span><strong>{renderStatusText(revision.render_status)}</strong>{revision.render_error ? <p>{revision.render_error}</p> : null}</div> : null}
    <div className="version-picker" aria-label="选择要比较的版本">{project.revisions.map((item) => <button key={item.id} className={item.id === selected ? "active" : ""} onClick={() => onSelect(item.id)}><span>V{item.number}</span><small>{item.render_engine ? rendererLabel(item.render_engine) : item.status === "active" ? "当前" : item.status === "draft" ? "草稿" : "归档"}</small></button>)}</div>
    {baseline ? <><div className={`asset-integrity ${sameAssets ? "pass" : "warn"}`}>{sameAssets ? <CircleCheck size={15} /> : <AlertTriangle size={15} />}<strong>{sameAssets ? "素材指纹一致" : "素材已发生变化"}</strong><span>{sameAssets ? "图片与音频 SHA-256 完全相同，渲染器对照有效。" : "本次版本差异不只来自渲染器，请谨慎比较。"}</span></div>{baselineVideo && revisionVideo ? <div className="renderer-compare"><article><header><span>V{baseline.number}</span><strong>{rendererLabel(baseline.render_engine || String(baseline.config.render_engine || ""))}</strong></header><video src={baselineVideo} controls preload="metadata" playsInline /></article><article><header><span>V{revision.number}</span><strong>{rendererLabel(revision.render_engine || String(revision.config.render_engine || ""))}</strong></header><video src={revisionVideo} controls preload="metadata" playsInline /></article></div> : null}<div className="revision-diff-summary"><GitCompareArrows size={16} /><strong>V{baseline.number} → V{revision.number}</strong><span>{changes.filter((item) => item.status === "changed").length} 修改 · {changes.filter((item) => item.status === "added").length} 新增 · {changes.filter((item) => item.status === "removed").length} 删除</span></div></> : null}
    <div className="scene-diff-list">{changes.map((change) => <article className={`scene-diff ${change.status}`} key={change.index}><header><span>SCENE {String(change.index + 1).padStart(2, "0")}</span><strong>{change.status === "same" ? "未变化" : change.status === "added" ? "新增镜头" : change.status === "removed" ? "删除镜头" : change.labels.join(" · ")}</strong></header><div className="scene-diff-columns"><div><small>{baseline ? `V${baseline.number}` : "BASE"}</small><p>{change.before?.narration || "—"}</p><em>{change.before?.visual_prompt || "—"}</em></div><ChevronRight size={15} /><div><small>V{revision.number}</small><p>{change.after?.narration || "—"}</p><em>{change.after?.visual_prompt || "—"}</em></div></div></article>)}</div>
  </section>;
}

function compareScene(before: Scene | undefined, after: Scene | undefined, index: number) {
  if (!before && after) return { index, before, after, status: "added" as const, labels: ["新增"] };
  if (before && !after) return { index, before, after, status: "removed" as const, labels: ["删除"] };
  if (!before || !after) return { index, before, after, status: "same" as const, labels: [] };
  const labels: string[] = [];
  if (before.narration !== after.narration) labels.push("旁白");
  if (before.visual_prompt !== after.visual_prompt) labels.push("画面提示词");
  if (Math.abs(before.duration - after.duration) > 0.05) labels.push("时长");
  if (before.image_motion !== after.image_motion || before.transition !== after.transition || Math.abs((before.transition_duration || 0) - (after.transition_duration || 0)) > 0.01) labels.push("关键帧");
  if (before.subtitle_effect !== after.subtitle_effect || JSON.stringify(before.subtitle_keywords || []) !== JSON.stringify(after.subtitle_keywords || []) || Math.abs((before.subtitle_start_offset || 0) - (after.subtitle_start_offset || 0)) > 0.01 || Math.abs((before.subtitle_end_offset || 0) - (after.subtitle_end_offset || 0)) > 0.01) labels.push("逐镜字幕");
  if (Math.abs((before.focus_x ?? 0.5) - (after.focus_x ?? 0.5)) > 0.01 || Math.abs((before.focus_y ?? 0.5) - (after.focus_y ?? 0.5)) > 0.01) labels.push("主体焦点");
  const beforeHash = before.artifacts.find((item) => item.kind === "source_media")?.sha256;
  const afterHash = after.artifacts.find((item) => item.kind === "source_media")?.sha256;
  if (beforeHash && afterHash && beforeHash !== afterHash) labels.push("素材");
  return { index, before, after, status: labels.length ? "changed" as const : "same" as const, labels };
}

function rendererAssetsMatch(before: Revision, after: Revision) {
  if (before.scenes.length !== after.scenes.length) return false;
  return before.scenes.every((scene, index) => {
    const target = after.scenes[index];
    if (!target) return false;
    const hashes = (value: Scene) => ["audio", "source_media"].map((kind) => value.artifacts.find((item) => item.kind === kind)?.sha256 || "");
    const [beforeAudio, beforeMedia] = hashes(scene);
    const [afterAudio, afterMedia] = hashes(target);
    return Boolean(beforeAudio && beforeMedia && beforeAudio === afterAudio && beforeMedia === afterMedia);
  });
}

function rendererLabel(engine?: string) { return engine === "hyperframes" ? "HyperFrames" : engine === "whiteboard_cv" ? "手绘白板动画" : engine === "native_image_html" ? "内部兼容合成" : "未标记渲染器"; }
function renderStatusText(status: Revision["render_status"]) { return ({ idle: "未创建对照", planned: "准备排队", pending: "等待渲染", running: "正在渲染", completed: "渲染完成", failed: "渲染失败", cancelled: "已取消" } as Record<string, string>)[status] || status; }

function qualityText(status: string) { return ({ pass: "通过", warn: "有警告", fail: "失败", stale: "待重检", pending: "检查中" } as Record<string, string>)[status] || status; }
function scopeText(scope?: string) { return ({ full: "完整重做", visual: "只换画面", voice: "只换配音", composition: "仅重新合成" } as Record<string, string>)[scope || ""] || "单镜重做"; }
function checkName(name: string) { return ({ file: "文件完整性", ffprobe: "媒体可解析", video_stream: "视频轨", video_codec: "视频编码", vertical_resolution: "竖屏分辨率", frame_rate: "帧率", audio_stream: "音频轨", duration: "时长一致性", audio_level: "音频响度", black_frames: "黑帧检测", frozen_frames: "冻结画面", subtitle_safe_area: "字幕安全区", signal_analysis: "信号分析" } as Record<string, string>)[name] || name; }
function repairPlanText(revision: Revision) { return revision.repair_plan?.steps.map((step) => `${scopeText(step.scope)}：第 ${step.scenes.join("、")} 镜`).join("；") || "修复计划已记录"; }
function detailText(detail: Record<string, unknown>) {
  const summary = detail.summary;
  if (typeof summary === "string" && summary.trim()) {
    const issues = Array.isArray(detail.issues) ? detail.issues.length : 0;
    return `${summary}${issues ? ` · ${issues} 项问题` : ""}`;
  }
  return Object.entries(detail)
    .map(([key, value]) => `${key}: ${detailValue(value)}`)
    .join(" · ");
}

function detailValue(value: unknown): string {
  if (value == null || value === "") return "无";
  if (Array.isArray(value)) {
    if (!value.length) return "无";
    if (value.some((item) => item != null && typeof item === "object")) return `${value.length} 项`;
    return value.map(detailValue).join("、");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return "无";
    return entries.slice(0, 4).map(([key, item]) => `${key}=${detailValue(item)}`).join("、");
  }
  return String(value);
}
function motionLabel(motion?: string) { return timelineMotions.find(([value]) => value === motion)?.[1] || motion || "静止"; }
function transitionLabel(transition?: string) { return timelineTransitions.find(([value]) => value === transition)?.[1] || transition || "直接切换"; }
function subtitleEffectLabel(effect?: string | null) { return sceneSubtitleEffects.find(([value]) => value === (effect || "inherit"))?.[1] || "版本默认"; }
function formatSubtitleWindow(scene: Scene) {
  const start = scene.subtitle_start_offset || 0;
  const end = Math.max(scene.duration - (scene.subtitle_end_offset || 0), start);
  return `${start.toFixed(2)}s → ${end.toFixed(2)}s`;
}
function isImageMediaUrl(value?: string) {
  if (!value) return false;
  const path = value.split(/[?#]/, 1)[0].toLocaleLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"].some((suffix) => path.endsWith(suffix));
}
function highlightedSubtitle(text: string, keywords: string[]) {
  if (!keywords.length) return text;
  const escaped = keywords
    .sort((left, right) => right.length - left.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");
  const matches = new Set(keywords.map((value) => value.toLocaleLowerCase()));
  return text.split(pattern).map((part, index) => matches.has(part.toLocaleLowerCase()) ? <mark key={`${part}:${index}`}>{part}</mark> : part);
}
function formatTime(seconds: number) { const safe = Math.max(seconds || 0, 0); return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${Math.floor(safe % 60).toString().padStart(2, "0")}.${Math.floor((safe % 1) * 10)}`; }
function motionPose(motion: string, focusX: number, focusY: number): [string, string] {
  const anchor = `焦点 ${Math.round(focusX * 100)}% / ${Math.round(focusY * 100)}%`;
  const poses: Record<string, [string, string]> = {
    none: [`1.00× · ${anchor}`, `1.00× · ${anchor}`],
    push_in: [`1.00× · ${anchor}`, `1.12× · ${anchor}`],
    pull_out: [`1.12× · ${anchor}`, `1.00× · ${anchor}`],
    pan_left: [`右侧起幅 · ${anchor}`, `左侧落幅 · ${anchor}`],
    pan_right: [`左侧起幅 · ${anchor}`, `右侧落幅 · ${anchor}`],
    pan_up: [`下方起幅 · ${anchor}`, `上方落幅 · ${anchor}`],
    pan_down: [`上方起幅 · ${anchor}`, `下方落幅 · ${anchor}`],
    ken_burns: [`1.02× · 左下起幅`, `1.12× · 右上落幅 · ${anchor}`],
  };
  return poses[motion] || poses.none;
}
