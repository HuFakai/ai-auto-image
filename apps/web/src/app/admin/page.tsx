"use client";

import { useEffect, useState } from "react";

interface AdminData {
  keys: Array<{ id: string; name: string; prefix: string; scopes: string; revoked: number; createdAt: string }>;
  webhooks: Array<{ id: string; url: string; events: string; enabled: number }>;
  workspace: { monthlyBudgetCny: number | null } | null;
  usage: {
    totalCents: number;
    byModel: Array<{ model: string; imageCount: number; promptTokens: number; completionTokens: number; cents: number }>;
    byDay: Array<{ day: string; cents: number }>;
  };
  accounts: Array<{ id: string; platform: string; alias: string; lastStatus: string | null; enabled: number }>;
  monthUsageCents: number;
}

export default function AdminPage() {
  const [data, setData] = useState<AdminData | null>(null);
  const [keyName, setKeyName] = useState("");
  const [newKey, setNewKey] = useState("");
  const [hookUrl, setHookUrl] = useState("");
  const [budget, setBudget] = useState("");
  const [account, setAccount] = useState({ platform: "xiaohongshu", alias: "", credential: "" });
  const [notice, setNotice] = useState("");

  async function load() {
    const [adminRes, platformRes] = await Promise.all([fetch("/api/admin"), fetch("/api/platform")]);
    const admin = await adminRes.json();
    const platform = await platformRes.json();
    setData({ ...admin, accounts: platform.accounts ?? [] });
    if (admin.workspace?.monthlyBudgetCny) setBudget(String(admin.workspace.monthlyBudgetCny));
  }

  useEffect(() => {
    load();
  }, []);

  async function post(body: unknown) {
    const res = await fetch("/api/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.json();
  }

  if (!data) return <div className="py-32 text-center text-ink-3">加载中…</div>;

  const maxDay = Math.max(1, ...data.usage.byDay.map((d) => d.cents));

  return (
    <div className="rise">
      <h1 className="font-display text-3xl font-bold tracking-tight">运营台</h1>
      <p className="mt-1 text-sm text-ink-2">成本账本基于实际 Provider usage 记录（整数分），账单不依赖估算。</p>

      {/* usage */}
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div className="card !cursor-default p-5">
          <h2 className="font-display text-lg font-bold">近 30 天成本</h2>
          <div className="font-display mt-2 text-4xl font-bold">
            ¥{(data.usage.totalCents / 100).toFixed(2)}
          </div>
          <div className="mt-4 flex h-24 items-end gap-1">
            {data.usage.byDay.slice(-30).map((d) => (
              <div
                key={d.day}
                title={`${d.day}: ¥${(d.cents / 100).toFixed(2)}`}
                className="flex-1 rounded-t bg-accent/70 transition-colors hover:bg-accent"
                style={{ height: `${Math.max(4, (d.cents / maxDay) * 96)}px` }}
              />
            ))}
            {data.usage.byDay.length === 0 && <span className="text-xs text-ink-3">暂无记录</span>}
          </div>
          {data.workspace?.monthlyBudgetCny && (
            <p className="mt-3 text-xs text-ink-2">
              本月预算 ¥{data.workspace.monthlyBudgetCny} · 已用 ¥{(data.monthUsageCents / 100).toFixed(2)}
              {data.workspace.monthlyBudgetCny * 100 - data.monthUsageCents <= 0 && <span className="text-accent"> · 已超支，生成将被阻止</span>}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <input className="input" placeholder="月预算（元，留空取消）" value={budget} onChange={(e) => setBudget(e.target.value)} />
            <button
              className="btn btn-ghost"
              onClick={async () => {
                await post({ action: "set_budget", monthlyBudgetCny: budget ? parseInt(budget, 10) : null });
                setNotice("预算已更新");
                load();
              }}
            >
              设置
            </button>
          </div>
        </div>

        <div className="card !cursor-default p-5">
          <h2 className="font-display text-lg font-bold">按模型拆分</h2>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-2">
                <th className="py-1.5">模型</th>
                <th className="py-1.5">图片数</th>
                <th className="py-1.5">Tokens</th>
                <th className="py-1.5 text-right">费用</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.byModel.map((m) => (
                <tr key={m.model} className="border-b border-line last:border-0">
                  <td className="py-2 font-mono text-xs">{m.model}</td>
                  <td className="py-2">{m.imageCount}</td>
                  <td className="py-2 text-xs">{(m.promptTokens + m.completionTokens).toLocaleString()}</td>
                  <td className="py-2 text-right font-semibold">¥{(m.cents / 100).toFixed(2)}</td>
                </tr>
              ))}
              {data.usage.byModel.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-ink-3">
                    暂无调用记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* api keys */}
      <div className="card !cursor-default mt-5 p-5">
        <h2 className="font-display text-lg font-bold">API Keys</h2>
        <div className="mt-3 flex gap-2">
          <input className="input max-w-xs" placeholder="密钥名称" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <button
            className="btn btn-primary"
            onClick={async () => {
              if (!keyName) return;
              const created = (await post({ action: "create_key", name: keyName, scopes: ["generate", "export"] })) as { key: string };
              setNewKey(created.key);
              setKeyName("");
              load();
            }}
          >
            创建密钥
          </button>
        </div>
        {newKey && (
          <p className="mt-2 rounded-[10px] border border-line bg-paper-2 px-3 py-2 font-mono text-xs">
            请立即保存（仅显示一次）：{newKey}
          </p>
        )}
        <table className="mt-3 w-full text-sm">
          <tbody>
            {data.keys.map((k) => (
              <tr key={k.id} className="border-b border-line last:border-0">
                <td className="py-2 font-semibold">{k.name}</td>
                <td className="py-2 font-mono text-xs">{k.prefix}…</td>
                <td className="py-2 text-xs">{JSON.parse(k.scopes).join(", ")}</td>
                <td className="py-2">
                  {k.revoked ? (
                    <span className="chip chip-accent">已吊销</span>
                  ) : (
                    <button
                      className="btn btn-ghost !py-1 !text-xs"
                      onClick={async () => {
                        await post({ action: "revoke_key", id: k.id });
                        load();
                      }}
                    >
                      吊销
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data.keys.length === 0 && (
              <tr>
                <td className="py-6 text-center text-ink-3" colSpan={4}>
                  暂无密钥
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* webhooks */}
      <div className="card !cursor-default mt-5 p-5">
        <h2 className="font-display text-lg font-bold">Webhooks</h2>
        <p className="mt-1 text-xs text-ink-2">事件：run.completed / run.failed / approval.required / draft.created / budget.threshold</p>
        <div className="mt-3 flex gap-2">
          <input className="input" placeholder="https://example.com/hook" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
          <button
            className="btn btn-primary"
            onClick={async () => {
              if (!hookUrl.startsWith("http")) return;
              await post({ action: "create_webhook", url: hookUrl, events: ["run.completed", "run.failed", "approval.required", "draft.created"] });
              setHookUrl("");
              load();
            }}
          >
            添加
          </button>
        </div>
        <ul className="mt-3 space-y-2 text-sm">
          {data.webhooks.map((h) => (
            <li key={h.id} className="flex items-center justify-between border-b border-line pb-2 last:border-0">
              <span className="font-mono text-xs">{h.url}</span>
              <button
                className="btn btn-ghost !py-1 !text-xs"
                onClick={async () => {
                  await post({ action: "delete_webhook", id: h.id });
                  load();
                }}
              >
                删除
              </button>
            </li>
          ))}
          {data.webhooks.length === 0 && <li className="py-4 text-center text-ink-3">暂无 Webhook</li>}
        </ul>
      </div>

      {/* platform accounts */}
      <div className="card !cursor-default mt-5 mb-10 p-5">
        <h2 className="font-display text-lg font-bold">平台账号</h2>
        <p className="mt-1 text-xs text-ink-2">小红书通过外部 xiaohongshu-mcp 服务集成（不保存 Cookie）；公众号使用官方 API 凭据。</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[120px_1fr_1fr_auto]">
          <select className="select" value={account.platform} onChange={(e) => setAccount({ ...account, platform: e.target.value })}>
            <option value="xiaohongshu">小红书</option>
            <option value="wechat">公众号</option>
          </select>
          <input className="input" placeholder="账号别名" value={account.alias} onChange={(e) => setAccount({ ...account, alias: e.target.value })} />
          <input
            className="input"
            placeholder={account.platform === "wechat" ? '{"appid":"...","secret":"..."}' : "留空（使用 XHS_MCP_URL 服务）"}
            value={account.credential}
            onChange={(e) => setAccount({ ...account, credential: e.target.value })}
          />
          <button
            className="btn btn-primary"
            onClick={async () => {
              if (!account.alias) return;
              const res = await fetch("/api/platform", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ platform: account.platform, alias: account.alias, credential: account.credential || undefined }),
              });
              const json = await res.json();
              setNotice(json.status?.ok ? `账号已添加：${json.status.message}` : `已添加，但检查未通过：${json.status?.message ?? "未知"}`);
              setAccount({ platform: account.platform, alias: "", credential: "" });
              load();
            }}
          >
            添加并检查
          </button>
        </div>
        <ul className="mt-3 space-y-2 text-sm">
          {data.accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between border-b border-line pb-2 last:border-0">
              <span>
                <span className="chip mr-2">{a.platform}</span>
                {a.alias}
              </span>
              <span className="max-w-md truncate text-xs text-ink-2">{a.lastStatus ?? "未检查"}</span>
            </li>
          ))}
          {data.accounts.length === 0 && <li className="py-4 text-center text-ink-3">暂无平台账号</li>}
        </ul>
        {notice && <p className="mt-3 text-sm">{notice}</p>}
      </div>
    </div>
  );
}
