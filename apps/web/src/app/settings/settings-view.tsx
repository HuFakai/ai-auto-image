"use client";

import { useCallback, useState } from "react";
import type { BrandKitView, ChannelView } from "@/lib/types";

interface ChannelsPayload {
  channels: ChannelView[];
  providerMode: string;
  providerLabel: string;
}

type TestState = { ok: boolean; detail: string } | "loading" | null;

const TYPE_LABEL: Record<string, string> = { text: "文本渠道", image: "图片渠道" };

const THEME_SWATCH: Record<string, { bg: string; ink: string; accent: string; label: string }> = {
  darkroom: { bg: "#0e0e10", ink: "#f4f1ea", accent: "#f5a524", label: "暗房工作室" },
  paper_minimal: { bg: "#faf7f2", ink: "#1c1814", accent: "#b5382d", label: "纸感极简" },
  high_contrast: { bg: "#111111", ink: "#ffffff", accent: "#ffd400", label: "高对比营销" },
  morandi: { bg: "#e8e2d9", ink: "#5b554a", accent: "#a1876f", label: "莫兰迪生活" },
  tech_dark: { bg: "#0e1420", ink: "#e6edf5", accent: "#38bdf8", label: "科技深色" },
  book_paper: { bg: "#f7f1e3", ink: "#3d3428", accent: "#8b5e34", label: "图书纸张" },
};

export function SettingsView({
  initial,
  initialKits,
}: {
  initial: ChannelsPayload;
  initialKits: BrandKitView[];
}) {
  const [data, setData] = useState<ChannelsPayload>(initial);
  const [kits, setKits] = useState<BrandKitView[]>(initialKits);
  const [editing, setEditing] = useState<ChannelView | "new" | null>(null);
  const [editingKit, setEditingKit] = useState<BrandKitView | "new" | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const reload = useCallback(async () => {
    const [channelsResponse, kitsResponse] = await Promise.all([
      fetch("/api/channels", { cache: "no-store" }),
      fetch("/api/brand-kits", { cache: "no-store" }),
    ]);
    if (channelsResponse.ok) setData((await channelsResponse.json()) as ChannelsPayload);
    if (kitsResponse.ok) {
      const body = (await kitsResponse.json()) as { kits: BrandKitView[] };
      setKits(body.kits);
    }
  }, []);

  async function toggle(channel: ChannelView) {
    await fetch(`/api/channels/${channel.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !channel.enabled }),
    });
    await reload();
  }

  async function removeChannel(channel: ChannelView) {
    if (!window.confirm(`删除渠道「${channel.name}」？密钥将一并清除。`)) return;
    await fetch(`/api/channels/${channel.id}`, { method: "DELETE" });
    await reload();
  }

  async function move(channel: ChannelView, direction: -1 | 1) {
    const sameType = data.channels.filter((c) => c.type === channel.type);
    const index = sameType.findIndex((c) => c.id === channel.id);
    const target = sameType[index + direction];
    if (!target) return;
    const ids = sameType.map((c) => c.id);
    [ids[index], ids[index + direction]] = [ids[index + direction]!, ids[index]!];
    await fetch("/api/channels/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    await reload();
  }

  async function test(channel: ChannelView) {
    setTests((prev) => ({ ...prev, [channel.id]: "loading" }));
    const response = await fetch(`/api/channels/${channel.id}/test`, { method: "POST" });
    const result = (await response.json()) as { ok?: boolean; detail?: string };
    setTests((prev) => ({
      ...prev,
      [channel.id]: { ok: Boolean(result.ok), detail: result.detail ?? "" },
    }));
  }

  async function removeKit(kit: BrandKitView) {
    if (!window.confirm(`删除品牌手册「${kit.name}」？`)) return;
    await fetch(`/api/brand-kits/${kit.id}`, { method: "DELETE" });
    await reload();
  }

  return (
    <div className="space-y-14 pt-10">
      <section className="rise">
        <p className="kicker">SETTINGS · 渠道与品牌</p>
        <h1 className="mt-3 font-display text-3xl font-black sm:text-4xl">
          设置<span className="text-seal">。</span>
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-soft">
          模型渠道与品牌手册均保存于数据库：渠道密钥加密落库（只显示末四位），保存即时生效。
          当前生效：<span className="ml-1 font-mono text-xs text-ink">{data.providerLabel}</span>
        </p>
      </section>

      {(["text", "image"] as const).map((type) => {
        const list = data.channels.filter((c) => c.type === type);
        return (
          <section key={type} className="rise" style={{ animationDelay: "60ms" }}>
            <div className="rule-double mb-2 flex items-baseline justify-between pt-2">
              <h2 className="font-display text-lg font-bold">{TYPE_LABEL[type]}</h2>
              <span className="kicker">
                {list.filter((c) => c.enabled).length} 启用 / {list.length}
              </span>
            </div>
            {list.length === 0 && (
              <p className="border border-dashed border-line-dark px-5 py-8 text-center text-sm text-ink-faint">
                暂无{TYPE_LABEL[type]}，未配置时使用 Mock。
              </p>
            )}
            <ul>
              {list.map((channel, index) => (
                <li key={channel.id} className="index-row px-3 py-4">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="w-7 font-mono text-[11px] text-ink-faint">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="font-display min-w-0 flex-1 truncate text-base font-semibold">
                      {channel.name}
                      {!channel.enabled && (
                        <span className="stamp stamp-quiet ml-2 text-[10px] text-ink-faint">停用</span>
                      )}
                    </span>
                    <span className="font-mono text-[11px] text-ink-soft">{channel.model ?? "—"}</span>
                    <span className="hidden font-mono text-[11px] text-ink-faint lg:inline">
                      {channel.baseUrl.replace(/^https?:\/\//, "")}
                    </span>
                    <span className="font-mono text-[11px] text-ink-faint">{channel.apiKeyHint}</span>
                    {channel.type === "image" && channel.imageEditSupport && (
                      <span className="stamp stamp-quiet text-[10px] text-seal">图生图</span>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        className="btn-ghost px-2.5 py-1 font-mono text-[11px]"
                        onClick={() => void test(channel)}
                        disabled={tests[channel.id] === "loading"}
                      >
                        {tests[channel.id] === "loading" ? "测试中…" : "测试"}
                      </button>
                      <button
                        className="btn-ghost px-2.5 py-1 font-mono text-[11px]"
                        onClick={() => setEditing(channel)}
                      >
                        编辑
                      </button>
                      <button
                        className="btn-ghost px-2.5 py-1 font-mono text-[11px]"
                        onClick={() => void toggle(channel)}
                      >
                        {channel.enabled ? "停用" : "启用"}
                      </button>
                      <button
                        className="btn-ghost px-1.5 py-1 font-mono text-[11px]"
                        onClick={() => void move(channel, -1)}
                        disabled={index === 0}
                        title="上移（优先级更高）"
                      >
                        ↑
                      </button>
                      <button
                        className="btn-ghost px-1.5 py-1 font-mono text-[11px]"
                        onClick={() => void move(channel, 1)}
                        disabled={index === list.length - 1}
                        title="下移"
                      >
                        ↓
                      </button>
                      <button
                        className="btn-ghost px-2.5 py-1 font-mono text-[11px] hover:!border-seal hover:!text-seal"
                        onClick={() => void removeChannel(channel)}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  {tests[channel.id] && tests[channel.id] !== "loading" && (
                    <p
                      className={`mt-2 pl-11 font-mono text-[11px] ${
                        (tests[channel.id] as { ok: boolean }).ok ? "text-seal" : "text-ink-soft"
                      }`}
                    >
                      {(tests[channel.id] as { ok: boolean }).ok ? "✓ " : "✗ "}
                      {(tests[channel.id] as { detail: string }).detail}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <button
              className="btn-ink mt-4 px-5 py-2 font-mono text-xs tracking-[0.15em]"
              onClick={() => setEditing("new")}
            >
              + 添加{TYPE_LABEL[type]}
            </button>
          </section>
        );
      })}

      {/* 品牌手册 */}
      <section className="rise" style={{ animationDelay: "120ms" }}>
        <div className="rule-double mb-2 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-lg font-bold">品牌手册</h2>
          <span className="kicker">{kits.length} 套</span>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-ink-faint">
          主题决定确定性排版的配色；风格关键词注入图片 Prompt；Logo 出现在确定性页面页脚。
          创作时在「品牌手册」下拉选择。
        </p>
        <ul>
          {kits.map((kit) => {
            const swatch = THEME_SWATCH[kit.themeId] ?? THEME_SWATCH.darkroom!;
            return (
              <li key={kit.id} className="index-row flex items-center gap-4 px-3 py-4">
                <span
                  className="h-9 w-9 shrink-0 rounded-sm border border-line-dark"
                  style={{ background: swatch.bg }}
                  title={swatch.label}
                >
                  <span
                    className="block h-full w-full scale-[0.62] rounded-sm"
                    style={{ background: swatch.accent }}
                  />
                </span>
                <span className="font-display min-w-0 flex-1 truncate text-base font-semibold">
                  {kit.name}
                  {kit.builtIn && <span className="stamp stamp-quiet ml-2 text-[10px] text-ink-faint">内置</span>}
                </span>
                <span className="hidden font-mono text-[11px] text-ink-soft md:inline">{swatch.label}</span>
                <span className="hidden font-mono text-[11px] text-ink-faint lg:inline">
                  {kit.styleKeywords.slice(0, 3).join(" · ") || "无风格词"}
                </span>
                <span className="font-mono text-[11px] text-ink-faint">
                  {kit.logoAssetId ? "有 Logo" : "无 Logo"}
                </span>
                <div className="flex items-center gap-2">
                  <button className="btn-ghost px-2.5 py-1 font-mono text-[11px]" onClick={() => setEditingKit(kit)}>
                    编辑
                  </button>
                  {!kit.builtIn && (
                    <button
                      className="btn-ghost px-2.5 py-1 font-mono text-[11px] hover:!border-seal hover:!text-seal"
                      onClick={() => void removeKit(kit)}
                    >
                      删除
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <button
          className="btn-ink mt-4 px-5 py-2 font-mono text-xs tracking-[0.15em]"
          onClick={() => setEditingKit("new")}
        >
          + 新建品牌手册
        </button>
      </section>

      {editing && (
        <ChannelForm
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
      {editingKit && (
        <KitForm
          editing={editingKit}
          onClose={() => setEditingKit(null)}
          onSaved={async () => {
            setEditingKit(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ChannelForm({
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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
      <div
        className="photo-frame max-h-[90vh] w-full max-w-xl overflow-y-auto p-7"
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
              placeholder="https://grok.aisenno.com/v1"
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

          {type === "image" && (
            <>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={imageEditSupport}
                onChange={(event) => setImageEditSupport(event.target.checked)}
                className="accent-[#b5382d]"
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

function KitForm({
  editing,
  onClose,
  onSaved,
}: {
  editing: BrandKitView | "new";
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isNew = editing === "new";
  const [name, setName] = useState(isNew ? "" : (editing as BrandKitView).name);
  const [themeId, setThemeId] = useState(isNew ? "darkroom" : (editing as BrandKitView).themeId);
  const [styleKeywords, setStyleKeywords] = useState(
    isNew ? "" : (editing as BrandKitView).styleKeywords.join("、"),
  );
  const [negativeKeywords, setNegativeKeywords] = useState(
    isNew ? "" : (editing as BrandKitView).negativeKeywords.join("、"),
  );
  const [logoAssetId, setLogoAssetId] = useState<string | null>(
    isNew ? null : (editing as BrandKitView).logoAssetId,
  );
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const swatch = THEME_SWATCH[themeId] ?? THEME_SWATCH.darkroom!;

  async function uploadLogo(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/assets/upload", { method: "POST", body: form });
      const result = (await response.json()) as { assetId?: string; error?: string };
      if (!response.ok || !result.assetId) throw new Error(result.error ?? `HTTP ${response.status}`);
      setLogoAssetId(result.assetId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    const split = (value: string) =>
      value
        .split(/[、,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 10);
    const payload = {
      name,
      themeId,
      styleKeywords: split(styleKeywords),
      negativeKeywords: split(negativeKeywords),
      ...(logoAssetId ? { logoAssetId } : {}),
    };
    try {
      const response = isNew
        ? await fetch("/api/brand-kits", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/brand-kits/${(editing as BrandKitView).id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
      <div
        className="photo-frame max-h-[90vh] w-full max-w-xl overflow-y-auto p-7"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
          <h3 className="font-display text-xl font-bold">{isNew ? "新建品牌手册" : "编辑品牌手册"}</h3>
          <span className="kicker">BRAND KIT</span>
        </div>

        <div className="space-y-5">
          <div>
            <span className="field-label">名称</span>
            <input
              className="field-input mt-1"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：主理人品牌"
            />
          </div>

          <div>
            <span className="field-label">主题（确定性排版配色）</span>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {Object.entries(THEME_SWATCH).map(([id, preset]) => (
                <button
                  key={id}
                  className={`rounded-sm border p-2 text-left transition-all ${
                    themeId === id ? "border-seal ring-1 ring-seal" : "border-line-dark hover:border-ink"
                  }`}
                  onClick={() => setThemeId(id)}
                >
                  <span
                    className="mb-1 block h-8 w-full rounded-sm border border-line"
                    style={{ background: preset.bg }}
                  >
                    <span
                      className="block h-2 w-2/3 translate-x-2 translate-y-2 rounded-sm"
                      style={{ background: preset.accent }}
                    />
                    <span
                      className="block h-1.5 w-1/2 translate-x-2 translate-y-3 rounded-sm"
                      style={{ background: preset.ink, opacity: 0.5 }}
                    />
                  </span>
                  <span className="font-mono text-[10px] text-ink-soft">{preset.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="field-label">风格关键词（顿号分隔 · 注入图片 Prompt）</span>
            <input
              className="field-input mt-1"
              placeholder="水彩插画、柔和光线、大量留白"
              value={styleKeywords}
              onChange={(event) => setStyleKeywords(event.target.value)}
            />
          </div>

          <div>
            <span className="field-label">禁止元素（顿号分隔）</span>
            <input
              className="field-input mt-1"
              placeholder="真人照片、竞品 Logo"
              value={negativeKeywords}
              onChange={(event) => setNegativeKeywords(event.target.value)}
            />
          </div>

          <div>
            <span className="field-label">Logo（PNG，≤5MB · 确定性页面页脚）</span>
            <div className="mt-2 flex items-center gap-3">
              {logoAssetId ? (
                <img
                  src={`/api/assets/${logoAssetId}`}
                  alt="Logo 预览"
                  className="h-10 w-10 border border-line object-contain"
                />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center border border-dashed border-line-dark text-[10px] text-ink-faint">
                  无
                </span>
              )}
              <label className="btn-ghost cursor-pointer px-3 py-1.5 font-mono text-[11px]">
                {uploading ? "上传中…" : logoAssetId ? "更换 Logo" : "上传 Logo"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadLogo(file);
                  }}
                />
              </label>
              {logoAssetId && (
                <button
                  className="btn-ghost px-2.5 py-1.5 font-mono text-[11px]"
                  onClick={() => setLogoAssetId(null)}
                >
                  移除
                </button>
              )}
            </div>
          </div>

          {error && <p className="font-mono text-xs text-seal">⚠ {error}</p>}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button className="btn-ghost px-5 py-2 text-sm" onClick={onClose}>
              取消
            </button>
            <button
              className="btn-ink px-6 py-2 text-sm"
              onClick={() => void save()}
              disabled={saving || !name}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
          <p className="border-t border-line pt-3 text-[11px] leading-relaxed text-ink-faint">
            当前主题：{swatch.label}。Brand Kit 在「创作」表单的品牌手册下拉中选择后生效。
          </p>
        </div>
      </div>
    </div>
  );
}
