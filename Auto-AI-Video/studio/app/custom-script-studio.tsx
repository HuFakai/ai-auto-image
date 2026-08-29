"use client";

import {
  Bot,
  Check,
  Columns3,
  FilePenLine,
  ListTree,
  LoaderCircle,
  Mic2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Timer,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Channel, CustomScriptRecommendation, WhiteboardTemplate } from "@/lib/types";
import { imageMotionOptions, sceneTransitionOptions } from "@/lib/scene-direction";

const modeOptions = [
  { value: "hyperframes", label: "HyperFrames", detail: "稳定批量、科普、电台与动态图形" },
  { value: "whiteboard_animation", label: "手绘白板动画", detail: "知识讲解与演示" },
  { value: "direct_video", label: "原生视频生成", detail: "连续运动与氛围镜头" },
] as const;

const subtitleOptions = [
  ["static", "静态"], ["fade_up", "淡入上浮"], ["typewriter", "打字机"], ["word_pop", "逐词弹入"],
] as const;

const recommendationTaskStorageKey = "pixelle.custom-script.recommendation-task-id";

export type ScriptRecommendationState = {
  phase: "idle" | "running" | "ready" | "error";
  message: string;
};

export function CustomScriptStudio({ channels, whiteboardTemplates, isOpen, onClose, onCreated, onRecommendationStateChange }: {
  channels: Channel[];
  whiteboardTemplates: WhiteboardTemplate[];
  isOpen: boolean;
  onClose: () => void;
  onCreated: (message: string) => void;
  onRecommendationStateChange: (state: ScriptRecommendationState) => void;
}) {
  const initialChannel = channels[0];
  const [channelId, setChannelId] = useState(channels[0]?.id || "");
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [originalScript, setOriginalScript] = useState<string | null>(null);
  const [rewriteEnabled, setRewriteEnabled] = useState(false);
  const [reviewMode, setReviewMode] = useState<"manual" | "ai_auto">("manual");
  const [recommendation, setRecommendation] = useState<CustomScriptRecommendation | null>(null);
  const [recommendationTaskId, setRecommendationTaskId] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState(String(initialChannel?.video.voice_id || "zh-CN-YunxiNeural"));
  const [ttsSpeed, setTtsSpeed] = useState(Number(initialChannel?.video.tts_speed || 1));
  const [bgmVolume, setBgmVolume] = useState(Number(initialChannel?.video.bgm_volume ?? 0.18));
  const [imageConcurrency, setImageConcurrency] = useState(Number(initialChannel?.video.image_generation_concurrency ?? 4));
  const [whiteboardTemplateId, setWhiteboardTemplateId] = useState(whiteboardTemplates[0]?.template_id || "");
  const [busy, setBusy] = useState<"recommend" | "submit" | "">("");
  const [error, setError] = useState("");
  function selectChannel(nextChannelId: string) {
    const nextChannel = channels.find((item) => item.id === nextChannelId);
    setChannelId(nextChannelId);
    setRecommendation(null);
    setOriginalScript(null);
    setVoiceId(String(nextChannel?.video.voice_id || "zh-CN-YunxiNeural"));
    setTtsSpeed(Number(nextChannel?.video.tts_speed || 1));
    setBgmVolume(Number(nextChannel?.video.bgm_volume ?? 0.18));
    setImageConcurrency(Number(nextChannel?.video.image_generation_concurrency ?? 4));
  }

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && busy !== "submit") onClose();
    }
    if (!isOpen) return;
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, isOpen, onClose]);

  const applyRecommendation = useCallback((next: CustomScriptRecommendation, fallbackScript: string) => {
    setRecommendation(next);
    setOriginalScript(next.original_script || fallbackScript);
    setTitle(next.title);
    setScript(next.script);
    onRecommendationStateChange({ phase: "ready", message: `制作单已就绪 · ${next.title}` });
  }, [onRecommendationStateChange]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      try {
        const storedTaskId = window.localStorage.getItem(recommendationTaskStorageKey);
        if (storedTaskId) setRecommendationTaskId(storedTaskId);
      } catch { /* private browsing can still keep the in-memory task */ }
    }, 0);
    return () => window.clearTimeout(initial);
  }, []);

  useEffect(() => {
    if (!recommendationTaskId || recommendation) return;
    let cancelled = false;
    async function pollTask() {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(recommendationTaskId || "")}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(detailOf(payload, "后台制作方案状态读取失败"));
        const task = payload as {
          status: string;
          error?: string | null;
          progress?: { message?: string } | null;
          result?: { recommendation?: CustomScriptRecommendation };
          request_params?: { channel_id?: string } | null;
        };
        if (cancelled) return;
        if (task.status === "completed" && task.result?.recommendation) {
          const restoredChannel = channels.find((item) => item.id === task.request_params?.channel_id);
          if (restoredChannel) {
            setChannelId(restoredChannel.id);
            setVoiceId(String(restoredChannel.video.voice_id || "zh-CN-YunxiNeural"));
            setTtsSpeed(Number(restoredChannel.video.tts_speed || 1));
            setBgmVolume(Number(restoredChannel.video.bgm_volume ?? 0.18));
            setImageConcurrency(Number(restoredChannel.video.image_generation_concurrency ?? 4));
          }
          applyRecommendation(task.result.recommendation, script);
          return;
        }
        if (task.status === "failed" || task.status === "cancelled") {
          window.localStorage.removeItem(recommendationTaskStorageKey);
          setRecommendationTaskId(null);
          const message = task.status === "cancelled" ? "AI 自动编排已取消" : task.error || "AI 自动编排失败";
          setError(message);
          onRecommendationStateChange({ phase: "error", message });
          return;
        }
        onRecommendationStateChange({ phase: "running", message: task.progress?.message || "AI 正在后台拆解文案与制作参数" });
        window.setTimeout(() => { if (!cancelled) void pollTask(); }, 2000);
      } catch (caught) {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : "后台制作方案状态读取失败";
        window.localStorage.removeItem(recommendationTaskStorageKey);
        setRecommendationTaskId(null);
        setError(message);
        onRecommendationStateChange({ phase: "error", message });
      }
    }
    void pollTask();
    return () => { cancelled = true; };
  }, [applyRecommendation, channels, onRecommendationStateChange, recommendation, recommendationTaskId, script]);

  async function recommend() {
    if (script.trim().length < 20) {
      setError("请至少输入 20 个字符的完整文案。");
      return;
    }
    setBusy("recommend"); setError("");
    onRecommendationStateChange({ phase: "running", message: "AI 正在后台拆解文案与制作参数" });
    onClose();
    try {
      const response = await fetch("/api/custom-script/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: channelId, script, title: title.trim() || null, rewrite_enabled: rewriteEnabled, review_mode: reviewMode }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(detailOf(payload, "AI 制作方案生成失败"));
      const next = payload as { task_id: string };
      window.localStorage.setItem(recommendationTaskStorageKey, next.task_id);
      setRecommendationTaskId(next.task_id);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "AI 制作方案生成失败";
      setError(message);
      onRecommendationStateChange({ phase: "error", message });
    } finally { setBusy(""); }
  }

  function patchRecommendation(updates: Partial<CustomScriptRecommendation>) {
    setRecommendation((current) => current ? { ...current, ...updates } : current);
  }

  function updateWorkingScript(value: string) {
    setScript(value);
    setRecommendation((current) => current ? {
      ...current,
      n_scenes: estimateSceneCount(value),
      scene_count_basis: sceneCountBasis(value),
    } : current);
  }

  async function submit() {
    if (!recommendation) return;
    setBusy("submit"); setError("");
    try {
      const response = await fetch("/api/custom-script/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel_id: channelId,
          script,
          original_script: rewriteEnabled ? originalScript : null,
          title,
          rewrite_enabled: rewriteEnabled,
          review_mode: reviewMode,
          production_mode: recommendation.production_mode,
          subtitle_effect: recommendation.subtitle_effect,
          n_scenes: recommendation.n_scenes,
          scene_strategy: "content_auto",
          content_policy: recommendation.content_policy,
          image_motion: recommendation.image_motion,
          transition: recommendation.transition,
          voice_id: voiceId,
          tts_speed: ttsSpeed,
          bgm_volume: bgmVolume,
          image_generation_concurrency: imageConcurrency,
          whiteboard_template_id: recommendation.production_mode === "whiteboard_animation" ? whiteboardTemplateId || null : null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(detailOf(payload, "自定义文案任务创建失败"));
      window.localStorage.removeItem(recommendationTaskStorageKey);
      setRecommendationTaskId(null);
      onRecommendationStateChange({ phase: "idle", message: "" });
      onCreated(reviewMode === "manual" ? "文案任务已进入分镜规划，完成后请在队列中人工确认" : "文案任务已进入全自动生产链路");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "自定义文案任务创建失败");
    } finally { setBusy(""); }
  }

  if (!isOpen) return null;

  return <div className="editor-overlay script-studio-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && busy !== "submit") onClose(); }}>
    <section className="script-studio" role="dialog" aria-modal="true" aria-labelledby="script-studio-title">
      <header className="script-studio-head">
        <div><span><FilePenLine size={15} /> CUSTOM COPY / RUN OF SHOW</span><h2 id="script-studio-title">自定义文案编排台</h2><p>先由 AI 排出制作任务单，再由你确认镜头语言与声音参数。</p></div>
        <button className="icon-button" onClick={onClose} disabled={busy === "submit"} aria-label={busy === "recommend" ? "最小化自定义文案编排台，AI 将继续在后台运行" : "关闭自定义文案编排台"}><X size={18} /></button>
      </header>
      <div className="script-studio-steps" data-ready={Boolean(recommendation)}><span className="active">01 文案入场</span><i /><span className={recommendation ? "active" : ""}>02 AI 制作单</span><i /><span className={recommendation ? "active" : ""}>03 确认开机</span></div>
      <div className="script-studio-body">
        <div className="script-manuscript">
          <div className="script-sheet-head"><span>MANUSCRIPT</span><em>{script.trim().length} 字</em></div>
          <label>任务标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="可留空，由 AI 拟定" maxLength={200} /></label>
          {rewriteEnabled && recommendation && originalScript ? <div className="script-comparison">
            <header><div><Columns3 size={15} /><span>REWRITE COMPARISON</span><strong>洗稿前后对照</strong></div><p>{formatDelta(originalScript.length, script.length)}</p></header>
            <div className="script-compare-grid">
              <label><span><i>01</i>原始文案 · 只读</span><textarea value={originalScript} readOnly aria-label="洗稿前原始文案" /></label>
              <label><span><i>02</i>优化文案 · 可编辑</span><textarea value={script} onChange={(event) => updateWorkingScript(event.target.value)} aria-label="洗稿后优化文案" /></label>
            </div>
            <button type="button" onClick={() => updateWorkingScript(originalScript)}><RotateCcw size={13} />恢复为原始文案</button>
          </div> : <label className="script-copy-field">完整文案<textarea value={script} onChange={(event) => updateWorkingScript(event.target.value)} placeholder="粘贴你的口播稿、早安电台文案、知识讲解稿或故事脚本……" /></label>}
          {recommendation ? <div className={`script-review-stamp ${recommendation.review_status}`}><Bot size={17} /><div><strong>{recommendation.review_status === "manual_pending" ? "等待人工审查" : recommendation.review_status === "pass" ? "AI 审查通过" : "AI 建议复核"}</strong><p>{recommendation.review_summary}</p></div></div> : null}
        </div>
        <aside className="script-rundown">
          <div className="rundown-heading"><SlidersHorizontal size={16} /><div><span>PRODUCTION RUNDOWN</span><strong>{recommendation ? "制作参数可调整" : "等待 AI 拆解文案"}</strong></div></div>
          <label>归属频道<select value={channelId} onChange={(event) => selectChannel(event.target.value)}>{channels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <div className="script-switches">
            <label><input type="checkbox" checked={rewriteEnabled} onChange={(event) => { setRewriteEnabled(event.target.checked); setRecommendation(null); setOriginalScript(null); }} /><span><strong>AI 洗稿 / 优化</strong><small>生成后并排展示原稿与优化稿</small></span></label>
            <label>审查方式<select value={reviewMode} onChange={(event) => { setReviewMode(event.target.value as "manual" | "ai_auto"); setRecommendation(null); }}><option value="manual">人工审查后生成</option><option value="ai_auto">AI 自动审查并推进</option></select></label>
          </div>
          {recommendation ? <>
            <div className="rundown-reason"><WandSparkles size={15} /><p>{recommendation.rationale}</p></div>
            <div className="rundown-grid">
              <label>画面方案<select value={recommendation.production_mode} onChange={(event) => patchRecommendation({ production_mode: event.target.value as CustomScriptRecommendation["production_mode"] })}>{modeOptions.map((item) => <option key={item.value} value={item.value}>{item.label} · {item.detail}</option>)}</select></label>
              <label>字幕效果<select value={recommendation.subtitle_effect} onChange={(event) => patchRecommendation({ subtitle_effect: event.target.value as CustomScriptRecommendation["subtitle_effect"] })}>{subtitleOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <div className="dynamic-scene-plan"><ListTree size={16} /><div><span>DYNAMIC STORY MAP</span><strong>自主拆镜 · 当前预估 {recommendation.n_scenes} 镜</strong><small>{recommendation.scene_count_basis}</small></div></div>
              <label>内容审校<select value={recommendation.content_policy} onChange={(event) => patchRecommendation({ content_policy: event.target.value as CustomScriptRecommendation["content_policy"] })}><option value="general">通用</option><option value="science">科普事实</option><option value="psychology">心理安全</option></select></label>
              <label>默认运镜<select value={recommendation.image_motion} onChange={(event) => patchRecommendation({ image_motion: event.target.value })}>{imageMotionOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              <label>默认转场<select value={recommendation.transition} onChange={(event) => patchRecommendation({ transition: event.target.value })}>{sceneTransitionOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              {recommendation.production_mode !== "direct_video" ? <label>图片生成并发<input type="number" min="1" max="32" value={imageConcurrency} onChange={(event) => setImageConcurrency(Number(event.target.value))} /><small>同时提交的分镜图片数量；建议本机使用 4～8。</small></label> : null}
              {recommendation.production_mode === "whiteboard_animation" ? <label className="wide">白板视觉模板<select value={whiteboardTemplateId} onChange={(event) => setWhiteboardTemplateId(event.target.value)}>{whiteboardTemplates.map((item) => <option key={item.template_id} value={item.template_id}>{item.display_name}</option>)}</select></label> : null}
            </div>
            <div className="voice-strip"><Mic2 size={15} /><label>声音 ID<input value={voiceId} onChange={(event) => setVoiceId(event.target.value)} /></label><label>语速<input type="number" min="0.5" max="2" step="0.1" value={ttsSpeed} onChange={(event) => setTtsSpeed(Number(event.target.value))} /></label><label>BGM 音量<input type="number" min="0" max="1" step="0.05" value={bgmVolume} onChange={(event) => setBgmVolume(Number(event.target.value))} /></label></div>
            <div className="script-production-proof"><span><ListTree size={13} />最终镜数由内容决定</span><span><Timer size={13} />预计口播 {estimateMinutes(script, ttsSpeed)} 分钟</span>{recommendation.production_mode !== "direct_video" ? <span><Sparkles size={13} />图片并行生成 ×{imageConcurrency}</span> : null}</div>
          </> : <div className="rundown-empty"><Sparkles size={25} /><strong>让 AI 先排一次制作单</strong><p>它会根据文案类型推荐画面方案、字幕、动态拆镜策略和导演参数。</p></div>}
        </aside>
      </div>
      {error ? <p className="editor-feedback script-studio-error" role="alert">{error}</p> : null}
      <footer className="script-studio-actions"><span>{recommendation ? "参数确认后将立即规划分镜" : "AI 编排会转入后台，你可以继续使用生产台"}</span><div><button className="secondary" onClick={() => void recommend()} disabled={Boolean(busy) || !channelId}>{busy === "recommend" ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}{recommendation ? "重新分析" : "AI 自动编排"}</button><button onClick={() => void submit()} disabled={Boolean(busy) || !recommendation || !title.trim() || !voiceId.trim()}>{busy === "submit" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}确认参数并开始生成</button></div></footer>
    </section>
  </div>;
}

function detailOf(payload: { detail?: unknown }, fallback: string) {
  return typeof payload.detail === "string" ? payload.detail : fallback;
}

function estimateSceneCount(value: string) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return 1;
  const sentences = cleaned.split(/(?<=[。.!?！？])\s*/).filter(Boolean);
  const units = sentences.flatMap((sentence) => {
    const clauses = sentence.split(/(?<=[，,；;：:、])/).filter(Boolean);
    const output: string[] = [];
    let current = "";
    for (let clause of clauses) {
      if (current && current.length + clause.length > 72) { output.push(current); current = ""; }
      while (clause.length > 72) { if (current) { output.push(current); current = ""; } output.push(clause.slice(0, 72)); clause = clause.slice(72); }
      current += clause;
    }
    if (current) output.push(current);
    return output;
  });
  const scenes: string[] = [];
  let current = "";
  for (const unit of units) {
    if (!current) current = unit;
    else if (current.length < 32 && current.length + unit.length <= 72) current += unit;
    else { scenes.push(current); current = unit; }
  }
  if (current) {
    if (scenes.length && current.length < 18 && scenes.at(-1)!.length + current.length <= 72) scenes[scenes.length - 1] += current;
    else scenes.push(current);
  }
  return Math.max(1, scenes.length);
}

function sceneCountBasis(value: string) {
  const length = value.replace(/\s+/g, "").length;
  const scenes = estimateSceneCount(value);
  return `按当前文案 ${length} 字符预估约 ${scenes} 镜；正式创建时按语义和口播节奏自主拆分，不设置数量上限`;
}

function estimateMinutes(value: string, speed: number) {
  return Math.max(0.1, Math.round(value.replace(/\s+/g, "").length / (240 * Math.max(speed, 0.5)) * 10) / 10);
}

function formatDelta(before: number, after: number) {
  const delta = after - before;
  return `${before} → ${after} 字符 · ${delta === 0 ? "长度持平" : delta > 0 ? `增加 ${delta}` : `精简 ${Math.abs(delta)}`}`;
}
