"use client";

import { useEffect, useState } from "react";

interface ProviderInfo {
  baseUrl: string;
  apiKey: string;
  model: string;
  editModel?: string;
}

export default function SettingsPage() {
  const [text, setText] = useState<ProviderInfo | null>(null);
  const [image, setImage] = useState<ProviderInfo | null>(null);
  const [concurrency, setConcurrency] = useState<{ defaultRequested: number; serverMax: number; postprocessMax: number } | null>(null);
  const [testResult, setTestResult] = useState("");
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState({ textBaseUrl: "", textKey: "", textModel: "", imgBaseUrl: "", imgKey: "", imgModel: "" });

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j) => {
        setText(j.text);
        setImage(j.image);
        setConcurrency(j.concurrency);
        setForm({
          textBaseUrl: j.text?.baseUrl ?? "",
          textKey: "",
          textModel: j.text?.model ?? "",
          imgBaseUrl: j.image?.baseUrl ?? "",
          imgKey: "",
          imgModel: j.image?.model ?? "",
        });
      });
  }, []);

  async function save() {
    setBusy("save");
    const body: Record<string, unknown> = {};
    if (form.textBaseUrl && form.textModel) {
      body.text = { baseUrl: form.textBaseUrl, apiKey: form.textKey || "unchanged", model: form.textModel };
    }
    if (form.imgBaseUrl && form.imgModel) {
      body.image = { baseUrl: form.imgBaseUrl, apiKey: form.imgKey || "unchanged", model: form.imgModel };
    }
    const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy("");
    setTestResult(res.ok ? "已保存。刷新后生效。" : "保存失败");
  }

  async function test(target: "text" | "image") {
    setBusy(`test-${target}`);
    setTestResult("");
    const payload =
      target === "text"
        ? { target, baseUrl: form.textBaseUrl, apiKey: form.textKey || (text?.apiKey.includes("***") ? "" : form.textKey), model: form.textModel }
        : { target, baseUrl: form.imgBaseUrl, apiKey: form.imgKey, model: form.imgModel };
    const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const json = await res.json();
    setBusy("");
    setTestResult(json.ok ? `✓ ${target === "text" ? `文本模型连通：${json.sample}` : `图片模型连通：返回 ${json.images} 张`}` : `✗ ${json.error}`);
  }

  return (
    <div className="rise mx-auto max-w-2xl">
      <h1 className="font-display text-3xl font-bold tracking-tight">设置</h1>
      <p className="mt-1 text-sm text-ink-2">Provider 密钥加密边界内存储，不出现在日志中。能力以显式配置为准，不按模型名猜测。</p>

      <div className="card !cursor-default mt-8 space-y-5 p-6">
        <h2 className="font-display text-lg font-bold">文本模型（OpenAI-compatible）</h2>
        <div>
          <label className="label">Base URL</label>
          <input className="input" value={form.textBaseUrl} onChange={(e) => setForm({ ...form, textBaseUrl: e.target.value })} placeholder="https://cap.aisenno.com/v1" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">API Key {text?.apiKey && <span className="text-ink-3">（当前 {text.apiKey}）</span>}</label>
            <input className="input" type="password" value={form.textKey} onChange={(e) => setForm({ ...form, textKey: e.target.value })} placeholder="留空保持不变" />
          </div>
          <div>
            <label className="label">模型名</label>
            <input className="input" value={form.textModel} onChange={(e) => setForm({ ...form, textModel: e.target.value })} placeholder="deepseek-v4-flash" />
          </div>
        </div>
        <button onClick={() => test("text")} disabled={busy !== ""} className="btn btn-ghost">
          {busy === "test-text" ? "测试中…" : "测试文本模型连接"}
        </button>
      </div>

      <div className="card !cursor-default mt-5 space-y-5 p-6">
        <h2 className="font-display text-lg font-bold">图片模型（Grok / xAI-compatible）</h2>
        <div>
          <label className="label">Base URL</label>
          <input className="input" value={form.imgBaseUrl} onChange={(e) => setForm({ ...form, imgBaseUrl: e.target.value })} placeholder="https://grok.aisenno.com/v1" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">API Key {image?.apiKey && <span className="text-ink-3">（当前 {image.apiKey}）</span>}</label>
            <input className="input" type="password" value={form.imgKey} onChange={(e) => setForm({ ...form, imgKey: e.target.value })} placeholder="留空保持不变" />
          </div>
          <div>
            <label className="label">模型名</label>
            <input className="input" value={form.imgModel} onChange={(e) => setForm({ ...form, imgModel: e.target.value })} placeholder="grok-imagine-image-2.0" />
          </div>
        </div>
        <button onClick={() => test("image")} disabled={busy !== ""} className="btn btn-ghost">
          {busy === "test-image" ? "测试中（约 20 秒）…" : "测试图片模型连接（真实出一张图）"}
        </button>
      </div>

      {concurrency && (
        <div className="card !cursor-default mt-5 p-6">
          <h2 className="font-display text-lg font-bold">并发安全上限（环境变量控制）</h2>
          <div className="mt-3 grid grid-cols-3 gap-4 text-center">
            {[
              ["默认并发", concurrency.defaultRequested],
              ["服务器上限", concurrency.serverMax],
              ["后处理并发", concurrency.postprocessMax],
            ].map(([label, v]) => (
              <div key={label as string} className="rounded-[10px] border border-line p-4">
                <div className="font-display text-2xl font-bold">{v as number}</div>
                <div className="mt-1 text-xs text-ink-2">{label as string}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-3">
            实际生效并发 = min(用户请求, 服务器上限, Provider 限流)。图片 API 与本地 Sharp 后处理使用独立信号量。
          </p>
        </div>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button onClick={save} disabled={busy !== ""} className="btn btn-primary">
          {busy === "save" ? "保存中…" : "保存设置"}
        </button>
        {testResult && <span className="text-sm">{testResult}</span>}
      </div>
    </div>
  );
}
