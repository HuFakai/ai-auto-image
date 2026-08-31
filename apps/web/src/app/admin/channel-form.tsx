"use client";

import { useState } from "react";
import type { ChannelView } from "@/lib/types";

export const TYPE_LABEL: Record<string, string> = { text: "文本渠道", image: "图片渠道" };

/** 模型渠道表单（后台「模型渠道」页使用；与旧设置页同一交互） */
export function ChannelForm({
  editing,
  onClose,
  onSaved,
}: {
  editing: ChannelView | "new";
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isNew = editing === "new";
  const [type, setType] = useState<"text" | "image">(isNew ? "image" : (editing as ChannelView).type);
  const [name, setName] = useState(isNew ? "" : (editing as ChannelView).name);
  const [baseUrl, setBaseUrl] = useState(isNew ? "" : (editing as ChannelView).baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(isNew ? "" : ((editing as ChannelView).model ?? ""));
  const [aspectRatioParam, setAspectRatioParam] = useState(
    isNew ? "aspect_ratio" : (editing as ChannelView).aspectRatioParam,
  );
  const [responseFormat, setResponseFormat] = useState(
    isNew ? "b64_json" : (editing as ChannelView).responseFormat,
  );
  const [resolution, setResolution] = useState(isNew ? "" : ((editing as ChannelView).resolution ?? ""));
  const [imageEditSupport, setImageEditSupport] = useState(
    isNew ? false : (editing as ChannelView).imageEditSupport,
  );
  const [concurrencyMax, setConcurrencyMax] = useState<string>(
    isNew ? "0" : String((editing as ChannelView).concurrencyMax),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        name,
        type,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(type === "text" ? { textModel: model } : { imageModel: model }),
        concurrencyMax: Math.max(0, Number.parseInt(concurrencyMax, 10) || 0),
      };
      if (type === "image") {
        payload.aspectRatioParam = aspectRatioParam;
        payload.responseFormat = responseFormat;
        payload.imageEditSupport = imageEditSupport;
        if (resolution) payload.resolution = resolution;
      }
      const response = isNew
        ? await fetch("/api/channels", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/channels/${(editing as ChannelView).id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          issues?: Array<{ message: string }>;
        };
        throw new Error(body.issues?.[0]?.message ?? body.error ?? `HTTP ${response.status}`);
      }
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#080706]/85 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-[14px] border border-line bg-paper-deep p-7 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
          <h3 className="font-display text-xl font-bold">{isNew ? "添加渠道" : "编辑渠道"}</h3>
          <span className="kicker">{TYPE_LABEL[type]}</span>
        </div>

        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-5">
            <div>
              <span className="field-label">类型</span>
              <select
                className="field-input mt-1"
                value={type}
                disabled={!isNew}
                onChange={(event) => setType(event.target.value as "text" | "image")}
              >
                <option value="image">图片生成</option>
                <option value="text">文本模型</option>
              </select>
            </div>
            <div>
              <span className="field-label">名称</span>
              <input
                className="field-input mt-1"
                placeholder="例如：Grok 图片 / 主力文本"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </div>

          <div>
            <span className="field-label">Base URL</span>
            <input
              className="field-input mt-1 font-mono !text-[13px]"
              placeholder="https://api.example.com/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>

          <div>
            <span className="field-label">
              API Key
              {!isNew && <span className="ml-2 normal-case tracking-normal text-ink-faint">留空则保持不变</span>}
            </span>
            <input
              className="field-input mt-1 font-mono !text-[13px]"
              placeholder={isNew ? "密钥" : `当前 ${(editing as ChannelView).apiKeyHint}`}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>

          <div>
            <span className="field-label">{type === "text" ? "文本模型" : "图片模型"}</span>
            <input
              className="field-input mt-1 font-mono !text-[13px]"
              placeholder={type === "text" ? "deepseek-v4-flash" : "grok-imagine-image-2.0"}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>

          <div>
            <span className="field-label">模型调用并发上限（0 = 不限制）</span>
            <input
              type="number"
              min={0}
              step={1}
              value={concurrencyMax}
              onChange={(event) => setConcurrencyMax(event.target.value)}
              placeholder="0"
              className="field-input mt-1 w-40"
            />
            <p className="mt-1 font-mono text-[10px] text-ink-faint">
              仅限制此渠道的同时调用数；默认 0，不限制文本或图片模型并发。
            </p>
          </div>

          {type === "image" && (
            <>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={imageEditSupport}
                onChange={(event) => setImageEditSupport(event.target.checked)}
                className="accent-[#ff2442]"
              />
              支持图片编辑（图生图）——漫画角色一致性、参考图生成将优先使用该渠道
            </label>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <span className="field-label">比例参数风格</span>
                <select
                  className="field-input mt-1"
                  value={aspectRatioParam}
                  onChange={(event) => setAspectRatioParam(event.target.value)}
                >
                  <option value="aspect_ratio">aspect_ratio（grok2api）</option>
                  <option value="size">size（OpenAI）</option>
                </select>
              </div>
              <div>
                <span className="field-label">返回格式</span>
                <select
                  className="field-input mt-1"
                  value={responseFormat}
                  onChange={(event) => setResponseFormat(event.target.value)}
                >
                  <option value="b64_json">b64_json（直出）</option>
                  <option value="url">url（需转存）</option>
                </select>
              </div>
              <div>
                <span className="field-label">分辨率（可选）</span>
                <input
                  className="field-input mt-1 font-mono !text-[13px]"
                  placeholder="如 2k"
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                />
              </div>
            </div>
            </>
          )}

          {error && <p className="font-mono text-xs text-seal">⚠ {error}</p>}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button className="btn-ghost px-5 py-2 text-sm" onClick={onClose}>
              取消
            </button>
            <button
              className="btn-ink px-6 py-2 text-sm"
              onClick={() => void save()}
              disabled={saving || !name || !baseUrl || (isNew && !apiKey) || !model}
            >
              {saving ? "保存中…" : "保存并生效"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
