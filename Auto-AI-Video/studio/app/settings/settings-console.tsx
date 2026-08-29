"use client";

import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Cpu,
  Database,
  Eye,
  EyeOff,
  Film,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Network,
  Plus,
  Radio,
  RefreshCw,
  Save,
  ServerCog,
  ShieldCheck,
  Trash2,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  ModelCapability,
  ModelChannel,
  ModelSelection,
  StudioSettings,
} from "@/lib/types";
import { TaskNotificationSettings } from "../task-notifications";

const capabilities: Array<{
  id: ModelCapability;
  label: string;
  eyebrow: string;
  description: string;
  icon: typeof MessageSquareText;
}> = [
  { id: "text", label: "文字模型", eyebrow: "SCRIPT / REASONING", description: "选题、脚本、分镜与 AI 制片", icon: MessageSquareText },
  { id: "image", label: "图片模型", eyebrow: "STILL / REFERENCE", description: "关键帧、参考图与封面素材", icon: ImageIcon },
  { id: "video", label: "视频模型", eyebrow: "MOTION / GENERATION", description: "文生视频、图生视频与镜头重做", icon: Film },
];

export function SettingsConsole({ initialSettings }: { initialSettings: StudioSettings }) {
  const [settings, setSettings] = useState(() => structuredClone(initialSettings));
  const [selectedId, setSelectedId] = useState(Object.keys(initialSettings.channels)[0] || "");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [discovered, setDiscovered] = useState<Record<string, string[]>>({});
  const [backupPath, setBackupPath] = useState("");
  const [rehearsal, setRehearsal] = useState<{ rehearsed?: boolean; integrity?: string; counts?: Record<string, number>; production_database_untouched?: boolean } | null>(null);

  const selected = selectedId ? settings.channels[selectedId] : undefined;
  const activeSummary = useMemo(
    () => capabilities.map((item) => ({ ...item, selection: settings.routing[item.id] })),
    [settings.routing],
  );

  function patchChannel(channelId: string, updates: Partial<ModelChannel>) {
    setSettings((current) => ({
      ...current,
      channels: {
        ...current.channels,
        [channelId]: { ...current.channels[channelId], ...updates },
      },
    }));
  }

  function patchModels(channelId: string, capability: ModelCapability, raw: string) {
    const models = Array.from(new Set(raw.split(/[\n,]/).map((value) => value.trim()).filter(Boolean)));
    const channel = settings.channels[channelId];
    patchChannel(channelId, { models: { ...channel.models, [capability]: models } });
  }

  function addChannel() {
    let index = Object.keys(settings.channels).length + 1;
    let id = `model-channel-${index}`;
    while (settings.channels[id]) id = `model-channel-${++index}`;
    const channel: ModelChannel = {
      name: `新模型渠道 ${index}`,
      api_format: "openai",
      base_url: "https://api.openai.com/v1",
      api_key: "",
      clear_api_key: false,
      api_key_configured: false,
      api_key_hint: "",
      enabled: true,
      use_proxy: false,
      user_agent: "",
      models: { text: [], image: [], video: [] },
      request_timeout: 300,
      poll_interval: 5,
      poll_timeout: 1800,
      retry_count: 3,
      job_store_dir: `data/model_jobs/${id}`,
    };
    setSettings((current) => ({
      ...current,
      channels: { ...current.channels, [id]: channel },
    }));
    setSelectedId(id);
    setFeedback("已添加未保存渠道，请填写连接信息和模型目录");
  }

  function removeChannel(channelId: string) {
    const usedBy = capabilities.filter((item) => settings.routing[item.id].channel_id === channelId);
    if (usedBy.length) {
      setError(`请先为${usedBy.map((item) => item.label).join("、")}切换其他渠道`);
      return;
    }
    setSettings((current) => {
      const channels = { ...current.channels };
      delete channels[channelId];
      return { ...current, channels };
    });
    setSelectedId(Object.keys(settings.channels).find((id) => id !== channelId) || "");
    setFeedback("渠道已从草稿移除，点击保存后生效");
  }

  function setChannelEnabled(channelId: string, enabled: boolean) {
    const usedBy = capabilities.filter((item) => settings.routing[item.id].channel_id === channelId);
    if (!enabled && usedBy.length) {
      setError(`请先为${usedBy.map((item) => item.label).join("、")}切换其他渠道，再停用当前渠道`);
      return;
    }
    patchChannel(channelId, { enabled });
  }

  function selectRoute(capability: ModelCapability, value: string) {
    const [channelId, model] = value ? JSON.parse(value) as [string, string] : ["", ""];
    setSettings((current) => ({
      ...current,
      routing: {
        ...current.routing,
        [capability]: {
          ...current.routing[capability],
          channel_id: channelId || "",
          model: model || "",
        },
      },
    }));
  }

  function patchFallback(capability: ModelCapability, index: number, value: string) {
    const [channelId, model] = value ? JSON.parse(value) as [string, string] : ["", ""];
    setSettings((current) => {
      const fallbacks = [...current.routing[capability].fallbacks];
      fallbacks[index] = { ...fallbacks[index], channel_id: channelId, model };
      return {
        ...current,
        routing: {
          ...current.routing,
          [capability]: { ...current.routing[capability], fallbacks },
        },
      };
    });
  }

  function addFallback(capability: ModelCapability) {
    setSettings((current) => ({
      ...current,
      routing: {
        ...current.routing,
        [capability]: {
          ...current.routing[capability],
          fallbacks: [...current.routing[capability].fallbacks, {
            channel_id: "",
            model: "",
            reasoning_effort: "none",
            fallbacks: [],
          }],
        },
      },
    }));
  }

  function moveFallback(capability: ModelCapability, index: number, direction: -1 | 1) {
    setSettings((current) => {
      const fallbacks = [...current.routing[capability].fallbacks];
      const next = index + direction;
      if (next < 0 || next >= fallbacks.length) return current;
      [fallbacks[index], fallbacks[next]] = [fallbacks[next], fallbacks[index]];
      return {
        ...current,
        routing: {
          ...current.routing,
          [capability]: { ...current.routing[capability], fallbacks },
        },
      };
    });
  }

  function removeFallback(capability: ModelCapability, index: number) {
    setSettings((current) => {
      const fallbacks = current.routing[capability].fallbacks.filter(
        (_, position) => position !== index,
      );
      return {
        ...current,
        routing: {
          ...current.routing,
          [capability]: { ...current.routing[capability], fallbacks },
        },
      };
    });
  }

  function selectReasoningEffort(value: ModelSelection["reasoning_effort"]) {
    setSettings((current) => ({
      ...current,
      routing: {
        ...current.routing,
        text: { ...current.routing.text, reasoning_effort: value },
      },
    }));
  }

  async function testChannel(channelId: string) {
    const channel = settings.channels[channelId];
    setBusy(`test:${channelId}`); setError(""); setFeedback("正在读取渠道模型目录…");
    try {
      const response = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...writableChannel(channel), channel_id: channelId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(detailOf(payload, "连接测试失败"));
      setDiscovered((current) => ({ ...current, [channelId]: payload.models || [] }));
      setFeedback(payload.message || "渠道连接成功");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "连接测试失败");
    } finally { setBusy(""); }
  }

  function importDiscovered(channelId: string, capability: ModelCapability) {
    const channel = settings.channels[channelId];
    const models = Array.from(new Set([...channel.models[capability], ...(discovered[channelId] || [])]));
    patchChannel(channelId, { models: { ...channel.models, [capability]: models } });
    setFeedback(`已把发现的模型加入${capabilities.find((item) => item.id === capability)?.label}目录，可继续删减`);
  }

  async function saveSettings() {
    setBusy("save"); setError(""); setFeedback("正在验证模型路由并原子写入配置…");
    try {
      const channels = Object.fromEntries(
        Object.entries(settings.channels).map(([id, channel]) => [id, writableChannel(channel)]),
      );
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channels, routing: settings.routing, runtime: settings.runtime }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(detailOf(payload, "设置保存失败"));
      setSettings(payload as StudioSettings);
      setFeedback(payload.message || "设置已保存");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "设置保存失败");
    } finally { setBusy(""); }
  }
  async function rehearseRestore() {
    setBusy("restore-rehearsal"); setError(""); setFeedback("正在隔离临时库中演练恢复…");
    try {
      const response = await fetch("/api/operations/restore/rehearsal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ backup_path: backupPath }) });
      const payload = await response.json(); if (!response.ok) throw new Error(detailOf(payload, "恢复演练失败"));
      setRehearsal(payload); setFeedback(payload.rehearsed ? "恢复演练通过，当前生产库未被覆盖" : "恢复演练未通过");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "恢复演练失败"); }
    finally { setBusy(""); }
  }

  return (
    <main className="settings-shell">
      <header className="settings-topbar">
        <Link href="/" className="settings-back"><ArrowLeft size={15} />返回生产台</Link>
        <div className="settings-brand"><span><ServerCog size={17} /></span><div><strong>PIXELLE / SYSTEM ROUTING</strong><small>MODEL CHANNEL CONTROL</small></div></div>
        <button className="settings-save" onClick={() => void saveSettings()} disabled={Boolean(busy)}>{busy === "save" ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}保存并热加载</button>
      </header>

      <section className="settings-hero">
        <div><p><Cpu size={14} /> ROUTING MATRIX / 01</p><h1>把模型能力<br />接到<em>正确的渠道。</em></h1></div>
        <aside><span>配置文件</span><code>{settings.config_file}</code><p><ShieldCheck size={14} />密钥永不返回浏览器；留空表示保留原密钥。</p></aside>
      </section>

      {error ? <div className="settings-alert error" role="alert"><CircleAlert size={16} /><span>{error}</span><button onClick={() => setError("")}>关闭</button></div> : null}
      {feedback ? <div className="settings-alert" role="status"><Radio size={15} /><span>{feedback}</span></div> : null}

      <section className="routing-board" aria-labelledby="routing-title">
        <header><div><span>ACTIVE ROUTES</span><h2 id="routing-title">三种能力，独立调度</h2></div><p>生产任务创建时冻结所选模型；修改只影响后续新任务。</p></header>
        <div className="routing-grid">
          {activeSummary.map((item) => <RoutingCard key={item.id} item={item} channels={settings.channels} onChange={(value) => selectRoute(item.id, value)} onReasoningChange={item.id === "text" ? selectReasoningEffort : undefined} onFallbackChange={(index, value) => patchFallback(item.id, index, value)} onFallbackAdd={() => addFallback(item.id)} onFallbackMove={(index, direction) => moveFallback(item.id, index, direction)} onFallbackRemove={(index) => removeFallback(item.id, index)} />)}
        </div>
      </section>

      <section className="settings-workbench">
        <aside className="channel-rail">
          <header><div><span>PROVIDER CHANNELS</span><strong>{Object.keys(settings.channels).length} 个渠道</strong></div><button onClick={addChannel} aria-label="添加模型渠道"><Plus size={15} /></button></header>
          <div>{Object.entries(settings.channels).map(([id, channel], index) => <button key={id} className={selectedId === id ? "active" : ""} onClick={() => { setSelectedId(id); setError(""); }}><i>{String(index + 1).padStart(2, "0")}</i><span><strong>{channel.name}</strong><small>{channel.api_format === "grok2api" ? "GROK2API EXTENSION" : "OPENAI API"} · {countModels(channel)} MODELS</small></span><em className={channel.enabled ? "online" : "offline"}>{channel.enabled ? "ON" : "OFF"}</em><ChevronRight size={13} /></button>)}</div>
          {!Object.keys(settings.channels).length ? <p>添加第一个模型渠道，然后分别登记文字、图片和视频模型。</p> : null}
        </aside>

        <div className="channel-editor-panel">
          {selected ? <>
            <header className="channel-editor-heading"><div><span>{selectedId}</span><h2>{selected.name}</h2><p>一个渠道是一组独立的 Base URL、密钥和调用策略。</p></div><div><button className="channel-test" onClick={() => void testChannel(selectedId)} disabled={Boolean(busy)}>{busy === `test:${selectedId}` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}测试 /models</button><button className="channel-remove" onClick={() => removeChannel(selectedId)} aria-label={`移除${selected.name}`}><Trash2 size={14} />移除</button></div></header>

            <div className="channel-form-grid">
              <label>渠道名称<input value={selected.name} onChange={(event) => patchChannel(selectedId, { name: event.target.value })} /></label>
              <label>API 格式<select value={selected.api_format} onChange={(event) => patchChannel(selectedId, { api_format: event.target.value as ModelChannel["api_format"] })}><option value="openai">OpenAI 官方兼容</option><option value="grok2api">grok2api 扩展</option></select><small>{selected.api_format === "openai" ? "Chat / Images / Videos SDK" : "Chat + /images + /videos/generations"}</small></label>
              <label className="wide">Base URL<input value={selected.base_url} onChange={(event) => patchChannel(selectedId, { base_url: event.target.value })} placeholder="https://api.example.com/v1" /></label>
              <label className="wide">API Key<div className="secret-input"><KeyRound size={14} /><input type={revealed[selectedId] ? "text" : "password"} value={selected.api_key ?? ""} onChange={(event) => patchChannel(selectedId, { api_key: event.target.value, clear_api_key: false })} placeholder={selected.clear_api_key ? "保存后将清除密钥" : selected.api_key_configured ? `已配置 ${selected.api_key_hint || "••••••••"}；留空保留` : "填写 Bearer API Key；本地服务可留空"} autoComplete="new-password" disabled={selected.clear_api_key} /><button type="button" onClick={() => setRevealed((current) => ({ ...current, [selectedId]: !current[selectedId] }))} aria-label="显示或隐藏 API Key">{revealed[selectedId] ? <EyeOff size={14} /> : <Eye size={14} />}</button></div>{selected.api_key_configured || selected.clear_api_key ? <button type="button" className="secret-clear" onClick={() => patchChannel(selectedId, { api_key: "", clear_api_key: !selected.clear_api_key })}>{selected.clear_api_key ? "撤销清除" : "清除已保存密钥"}</button> : null}</label>
              <label>请求超时 / 秒<input type="number" min="1" max="3600" value={selected.request_timeout} onChange={(event) => patchChannel(selectedId, { request_timeout: Number(event.target.value) })} /></label>
              <label>失败重试<input type="number" min="1" max="10" value={selected.retry_count} onChange={(event) => patchChannel(selectedId, { retry_count: Number(event.target.value) })} /></label>
              <label>轮询间隔 / 秒<input type="number" min="0" max="300" value={selected.poll_interval} onChange={(event) => patchChannel(selectedId, { poll_interval: Number(event.target.value) })} /></label>
              <label>轮询上限 / 秒<input type="number" min="1" max="86400" value={selected.poll_timeout} onChange={(event) => patchChannel(selectedId, { poll_timeout: Number(event.target.value) })} /></label>
              <label className="wide">任务恢复目录<input value={selected.job_store_dir} onChange={(event) => patchChannel(selectedId, { job_store_dir: event.target.value })} /></label>
              <label className="wide">兼容 User-Agent<input value={selected.user_agent} onChange={(event) => patchChannel(selectedId, { user_agent: event.target.value })} placeholder="通常留空；部分反代 WAF 需要指定" /></label>
              <label className="switch-field"><input type="checkbox" checked={selected.enabled} onChange={(event) => setChannelEnabled(selectedId, event.target.checked)} /><span>启用这个渠道</span></label>
              <label className="switch-field"><input type="checkbox" checked={selected.use_proxy} onChange={(event) => patchChannel(selectedId, { use_proxy: event.target.checked })} /><span>使用全局显式代理</span></label>
            </div>

            {discovered[selectedId]?.length ? <div className="model-discovery"><div><Network size={16} /><span><strong>发现 {discovered[selectedId].length} 个模型</strong><small>{discovered[selectedId].slice(0, 6).join(" · ")}{discovered[selectedId].length > 6 ? " …" : ""}</small></span></div><div>{capabilities.map((item) => <button key={item.id} onClick={() => importDiscovered(selectedId, item.id)}>导入到{item.label}</button>)}</div></div> : null}

            <div className="model-catalog-grid">{capabilities.map((item) => <ModelCatalog key={item.id} capability={item} value={selected.models[item.id]} onChange={(value) => patchModels(selectedId, item.id, value)} />)}</div>
          </> : <div className="channel-empty"><ServerCog size={36} /><h2>还没有模型渠道</h2><p>添加 OpenAI-compatible 或 grok2api 渠道开始配置。</p><button onClick={addChannel}><Plus size={14} />添加渠道</button></div>}
        </div>
      </section>

      <RuntimePanel settings={settings} onChange={setSettings} />
      <section className="restore-rehearsal-panel"><header><div><span>RECOVERY / 03</span><h2>备份恢复演练</h2></div><p>仅复制到临时 SQLite 校验，不覆盖当前生产数据库。</p></header><div><label>备份目录<input value={backupPath} onChange={(event) => setBackupPath(event.target.value)} placeholder="data/backups/pixelle-…" /></label><button onClick={() => void rehearseRestore()} disabled={!backupPath.trim() || Boolean(busy)}>{busy === "restore-rehearsal" ? <LoaderCircle className="spin" size={14} /> : <Database size={14} />}执行一次性演练</button></div>{rehearsal ? <pre>{JSON.stringify(rehearsal, null, 2)}</pre> : null}</section>
    </main>
  );
}

function RoutingCard({ item, channels, onChange, onReasoningChange, onFallbackChange, onFallbackAdd, onFallbackMove, onFallbackRemove }: {
  item: (typeof capabilities)[number] & { selection: ModelSelection };
  channels: Record<string, ModelChannel>;
  onChange: (value: string) => void;
  onReasoningChange?: (value: ModelSelection["reasoning_effort"]) => void;
  onFallbackChange: (index: number, value: string) => void;
  onFallbackAdd: () => void;
  onFallbackMove: (index: number, direction: -1 | 1) => void;
  onFallbackRemove: (index: number) => void;
}) {
  const Icon = item.icon;
  const options = Object.entries(channels).flatMap(([channelId, channel]) => channel.enabled ? channel.models[item.id].map((model) => ({ channelId, channel, model })) : []);
  const value = item.selection.channel_id && item.selection.model ? JSON.stringify([item.selection.channel_id, item.selection.model]) : "";
  return <article className={`routing-card ${value ? "configured" : "missing"}`}><header><span><Icon size={17} /></span><small>{item.eyebrow}</small><i>{value ? <Check size={13} /> : <CircleAlert size={13} />}</i></header><h3>{item.label}</h3><p>{item.description}</p><label><span>当前路由</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">未配置</option>{options.map(({ channelId, channel, model }) => <option key={`${channelId}:${model}`} value={JSON.stringify([channelId, model])}>{channel.name} / {model}</option>)}</select></label>{onReasoningChange ? <label className="reasoning-effort"><span>思考强度</span><select value={item.selection.reasoning_effort || "none"} onChange={(event) => onReasoningChange(event.target.value as ModelSelection["reasoning_effort"])}><option value="none">关闭 · 通用兼容</option><option value="low">低 · 更快产出</option><option value="medium">中 · 平衡质量</option><option value="high">高 · 深度策划</option></select><small>仅发送给文字模型；渠道不支持时请选“关闭”。</small></label> : null}<div className="fallback-routes"><header><span>备用模型</span><button type="button" onClick={onFallbackAdd}>添加</button></header>{item.selection.fallbacks.map((fallback, index) => {
    const fallbackValue = fallback.channel_id && fallback.model ? JSON.stringify([fallback.channel_id, fallback.model]) : "";
    return <div className="fallback-route" key={`${fallbackValue}:${index}`}><select value={fallbackValue} onChange={(event) => onFallbackChange(index, event.target.value)} aria-label={`${item.label}备用模型 ${index + 1}`}><option value="">选择备用模型</option>{options.map(({ channelId, channel, model }) => <option key={`${channelId}:${model}`} value={JSON.stringify([channelId, model])}>{channel.name} / {model}</option>)}</select><button type="button" disabled={index === 0} onClick={() => onFallbackMove(index, -1)} aria-label={`上移${item.label}备用模型 ${index + 1}`}>↑</button><button type="button" disabled={index === item.selection.fallbacks.length - 1} onClick={() => onFallbackMove(index, 1)} aria-label={`下移${item.label}备用模型 ${index + 1}`}>↓</button><button type="button" onClick={() => onFallbackRemove(index)} aria-label={`移除${item.label}备用模型 ${index + 1}`}>×</button></div>;
  })}{!item.selection.fallbacks.length ? <p>首选耗尽重试后按此顺序切换。</p> : null}</div></article>;
}

function ModelCatalog({ capability, value, onChange }: {
  capability: (typeof capabilities)[number];
  value: string[];
  onChange: (raw: string) => void;
}) {
  const Icon = capability.icon;
  return <article className={`model-catalog ${capability.id}`}><header><span><Icon size={15} /></span><div><strong>{capability.label}</strong><small>{value.length} MODELS REGISTERED</small></div></header><textarea value={value.join("\n")} onChange={(event) => onChange(event.target.value)} placeholder={`每行一个模型，例如：\n${capability.id === "text" ? "gpt-5.2" : capability.id === "image" ? "gpt-image-2" : "sora-2"}`} /><p>支持换行或英文逗号分隔。</p></article>;
}

function RuntimePanel({ settings, onChange }: { settings: StudioSettings; onChange: Dispatch<SetStateAction<StudioSettings>> }) {
  function patch(updates: Partial<StudioSettings["runtime"]>) {
    onChange((current) => ({ ...current, runtime: { ...current.runtime, ...updates } }));
  }

  return (
    <section className="runtime-panel">
      <header>
        <div><span>RUNTIME / 02</span><h2>声音、模板与网络</h2></div>
        <p>集中管理不属于单个生产频道的系统默认值；保存后仅影响新任务。</p>
      </header>
      <div className="runtime-grid">
        <article>
          <div className="runtime-title"><Volume2 size={18} /><span><strong>Edge TTS</strong><small>默认配音</small></span></div>
          <label>声音 ID<input value={settings.runtime.tts_voice} onChange={(event) => patch({ tts_voice: event.target.value })} /></label>
          <label>语速 · {settings.runtime.tts_speed.toFixed(1)}×<input type="range" min="0.5" max="2" step="0.1" value={settings.runtime.tts_speed} onChange={(event) => patch({ tts_speed: Number(event.target.value) })} /></label>
        </article>
        <article>
          <div className="runtime-title"><Network size={18} /><span><strong>显式网络代理</strong><small>不会继承系统代理</small></span></div>
          <label>HTTP / SOCKS 代理<input value={settings.runtime.local_proxy} onChange={(event) => patch({ local_proxy: event.target.value })} placeholder="http://127.0.0.1:7890" /></label>
          <label className="switch-field"><input type="checkbox" checked={settings.runtime.print_model_input} onChange={(event) => patch({ print_model_input: event.target.checked })} /><span>调试日志记录模型输入</span></label>
        </article>
        <article>
          <div className="runtime-title"><Database size={18} /><span><strong>渲染默认值</strong><small>频道未覆盖时使用</small></span></div>
          <label>默认模板<input value={settings.runtime.default_template} onChange={(event) => patch({ default_template: event.target.value })} /></label>
        </article>
        <TaskNotificationSettings />
      </div>
      <div className="prompt-defaults">
        <label>图片统一提示词<textarea value={settings.runtime.image_prompt_prefix} onChange={(event) => patch({ image_prompt_prefix: event.target.value })} /></label>
        <label>视频统一提示词<textarea value={settings.runtime.video_prompt_prefix} onChange={(event) => patch({ video_prompt_prefix: event.target.value })} /></label>
      </div>
    </section>
  );
}

function writableChannel(channel: ModelChannel) {
  return {
    name: channel.name,
    api_format: channel.api_format,
    base_url: channel.base_url,
    api_key: channel.api_key || undefined,
    clear_api_key: Boolean(channel.clear_api_key),
    enabled: channel.enabled,
    use_proxy: channel.use_proxy,
    user_agent: channel.user_agent,
    models: channel.models,
    request_timeout: channel.request_timeout,
    poll_interval: channel.poll_interval,
    poll_timeout: channel.poll_timeout,
    retry_count: channel.retry_count,
    job_store_dir: channel.job_store_dir,
  };
}

function countModels(channel: ModelChannel) {
  return channel.models.text.length + channel.models.image.length + channel.models.video.length;
}

function detailOf(payload: { detail?: unknown }, fallback: string) {
  return typeof payload.detail === "string" ? payload.detail : fallback;
}
