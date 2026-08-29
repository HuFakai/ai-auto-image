"use client";

import { Check, Hand, ScanLine } from "lucide-react";
import type { WhiteboardTemplate } from "@/lib/types";
import styles from "./whiteboard-template-picker.module.css";

type WhiteboardSettings = {
  template_id: string;
  template_version: number;
  hand_enabled: boolean;
  fallback_policy: string;
  render_profile?: Record<string, unknown>;
};

export function WhiteboardTemplatePicker({
  templates,
  settings,
  onSelect,
  onChange,
}: {
  templates: WhiteboardTemplate[];
  settings: WhiteboardSettings;
  onSelect: (template: WhiteboardTemplate) => void;
  onChange: (key: string, value: unknown) => void;
}) {
  const selected = templates.find(
    (template) => template.template_id === settings.template_id
      && template.version === settings.template_version,
  );
  const profile = { ...(selected?.render_profile ?? {}), ...(settings.render_profile ?? {}) };

  return (
    <fieldset className={styles.workbench}>
      <legend>白板视觉模板</legend>
      <header className={styles.header}>
        <div>
          <span>CS-BOARD VISUAL CONTACT SHEET</span>
          <strong>选择手绘语言，而不是 HTML 画面模板</strong>
          <p>每套预设会冻结生图配方与本地描绘参数；白板渲染器按笔迹逐步揭示画面。</p>
        </div>
        <em>{templates.length} 套视觉预设</em>
      </header>
      <div className={styles.sheet} role="radiogroup" aria-label="白板视觉模板">
        {templates.map((template, index) => {
          const active = template.template_id === settings.template_id
            && template.version === settings.template_version;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={active}
              className={active ? styles.active : undefined}
              key={`${template.template_id}@${template.version}`}
              onClick={() => onSelect(template)}
            >
              <span className={styles.number}>{String(index + 1).padStart(2, "0")}</span>
              <span className={styles.preview}>
                {/* The immutable image is proxied by this Studio server. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/whiteboard-preview/${encodeURIComponent(template.template_id)}/${template.version}`}
                  alt={`${template.display_name}实际效果`}
                  loading="lazy"
                />
              </span>
              <span className={styles.meta}>
                <strong>{template.display_name}</strong>
                <small>{template.description}</small>
                <span>{template.recommended_for.slice(0, 3).map((tag) => <i key={tag}>{tag}</i>)}</span>
              </span>
              <span className={styles.select}>{active ? <><Check size={13} />已选择</> : "使用此风格"}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.controls}>
        <label>
          <span><ScanLine size={15} />笔迹细节</span>
          <select
            value={String(profile.stroke_detail ?? "standard")}
            onChange={(event) => onChange("render_profile", { ...profile, stroke_detail: event.target.value })}
          >
            <option value="light">快速概括</option>
            <option value="standard">标准</option>
            <option value="detailed">细致</option>
            <option value="full">完整描绘</option>
          </select>
        </label>
        <label>
          <span>低特征画面后备</span>
          <select value={settings.fallback_policy} onChange={(event) => onChange("fallback_policy", event.target.value)}>
            <option value="grid">智能网格描绘</option>
            <option value="region">色块区域描绘</option>
            <option value="fail">直接报错等待处理</option>
          </select>
        </label>
        <label className={styles.toggle}>
          <input type="checkbox" checked={settings.hand_enabled} onChange={(event) => onChange("hand_enabled", event.target.checked)} />
          <span><Hand size={15} />显示绘画手势</span>
          <small>关闭后只保留笔迹与颜色逐步出现</small>
        </label>
      </div>
      <p className={styles.notice}>独立渲染链：图片模型 → OpenCV 笔迹分析 → 手绘揭示 → 独立字幕层 → FFmpeg 成片。不会调用原生 HTML 或 HyperFrames 模板。</p>
    </fieldset>
  );
}
