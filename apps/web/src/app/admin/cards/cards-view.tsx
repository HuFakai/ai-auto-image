"use client";

import { useCallback, useState } from "react";
import { formatBeijingDateTime } from "@/lib/time";

type CardSettings = { systemEnabled: boolean; redeemEnabled: boolean; apiEnabled: boolean };
type PlanItem = { id: string; name: string; periodDays: number; creditsPerPeriod: number };
export type Benefit =
  | { type: "credits"; credits: number }
  | { type: "subscription"; planId: string; planName: string; periodDays: number; creditsPerPeriod: number }
  | { type: "combo"; planId: string; planName: string; periodDays: number; creditsPerPeriod: number; credits: number };
type BatchItem = {
  id: string;
  batchNo: string;
  name: string;
  benefitType: string;
  benefit: Benefit | null;
  quantity: number;
  status: string;
  expiresAt: number | null;
  source: string;
  externalBatchId: string | null;
  salesChannel: string | null;
  remark: string | null;
  createdAt: number;
  stats: Record<string, number>;
};
type ApiKeyItem = {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  ipAllowlist: string[];
  rateLimitPerMinute: number;
  webhookUrl: string | null;
  status: string;
  lastUsedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
};
type WebhookItem = {
  id: string;
  eventId: string;
  eventType: string;
  resourceId: string;
  endpointUrl: string;
  status: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  deliveredAt: number | null;
  createdAt: number;
};
type CardSummary = {
  batchCount: number;
  cardCount: number;
  active: number;
  redeemed: number;
  disabled: number;
  expired: number;
  redeemedCredits: number;
  redeemedOrders: number;
};
type Pagination = { total: number; page: number; pageSize: number; totalPages: number };

const EMPTY_BATCH = {
  name: "",
  type: "credits" as "credits" | "subscription" | "combo",
  credits: "100",
  planId: "",
  quantity: "10",
  expiresAt: "",
  salesChannel: "",
  externalBatchId: "",
  remark: "",
};

const EMPTY_KEY = { name: "", scopes: ["cards:generate"], ipAllowlist: "", rateLimitPerMinute: "60", webhookUrl: "", expiresAt: "" };
const BENEFIT_LABEL: Record<string, string> = { credits: "点数卡", subscription: "会员卡", combo: "会员 + 点数" };
const STATUS_LABEL: Record<string, string> = { active: "可兑换", disabled: "已停用", redeemed: "已兑换", expired: "已过期" };
const WEBHOOK_STATUS_LABEL: Record<string, string> = { pending: "待投递", sending: "投递中", delivered: "已送达", failed: "失败" };

function dateValue(value: number | null): string {
  return value ? formatBeijingDateTime(value) : "长期有效";
}

function errorText(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : fallback;
}

export function CardsView({
  initialSettings,
  initialBatches,
  initialPagination,
  initialApiKeys,
  initialWebhooks,
  plans,
  summary,
}: {
  initialSettings: CardSettings;
  initialBatches: BatchItem[];
  initialPagination: Pagination;
  initialApiKeys: ApiKeyItem[];
  initialWebhooks: { items: WebhookItem[]; pagination: Pagination };
  plans: PlanItem[];
  summary: CardSummary;
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [batches, setBatches] = useState(initialBatches);
  const [pagination, setPagination] = useState(initialPagination);
  const [apiKeys, setApiKeys] = useState(initialApiKeys);
  const [webhooks, setWebhooks] = useState(initialWebhooks.items);
  const [webhookPaging, setWebhookPaging] = useState(initialWebhooks.pagination);
  const [summaryView, setSummaryView] = useState(summary);
  const [batchForm, setBatchForm] = useState(EMPTY_BATCH);
  const [keyForm, setKeyForm] = useState(EMPTY_KEY);
  const [generated, setGenerated] = useState<{ batchNo: string; name: string; cards: Array<{ code: string }> } | null>(null);
  const [newKeySecret, setNewKeySecret] = useState<{ token: string; webhookSecret: string | null } | null>(null);
  const [detail, setDetail] = useState<{ batch: BatchItem; stats: Record<string, number>; cards: Array<{ id: string; codePrefix: string; codeLast4: string; status: string; redeemedAt: number | null; username: string | null }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reloadBatches = useCallback(async (page = 1) => {
    const response = await fetch(`/api/admin/cards/batches?page=${page}&pageSize=20`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as { batches: BatchItem[]; pagination: Pagination };
    setBatches(payload.batches);
    setPagination(payload.pagination);
  }, []);

  const reloadKeys = useCallback(async () => {
    const response = await fetch("/api/admin/cards/api-keys", { cache: "no-store" });
    if (response.ok) setApiKeys(((await response.json()) as { apiKeys: ApiKeyItem[] }).apiKeys);
  }, []);

  const reloadSummary = useCallback(async () => {
    const response = await fetch("/api/admin/cards/summary", { cache: "no-store" });
    if (response.ok) setSummaryView((await response.json()) as CardSummary);
  }, []);

  const reloadWebhooks = useCallback(async (page = 1) => {
    const response = await fetch(`/api/admin/cards/webhooks?page=${page}&pageSize=20`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as { deliveries: WebhookItem[]; pagination: Pagination };
    setWebhooks(payload.deliveries);
    setWebhookPaging(payload.pagination);
  }, []);

  async function updateSetting(key: keyof CardSettings, value: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/cards/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const payload = (await response.json()) as CardSettings & { error?: string };
      if (!response.ok) throw new Error(errorText(payload, "设置保存失败"));
      setSettings(payload);
      setMessage("✓ 卡密设置已保存");
    } catch (error) {
      setMessage(`⚠ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function createBatch() {
    setBusy(true);
    setMessage(null);
    try {
      const plan = plans.find((item) => item.id === batchForm.planId);
      const type = batchForm.type;
      const benefit = type === "credits"
        ? { type, credits: Number.parseInt(batchForm.credits, 10) }
        : { type, planId: batchForm.planId, ...(type === "combo" ? { credits: Number.parseInt(batchForm.credits, 10) } : {}) };
      if (type !== "credits" && !plan) throw new Error("请选择会员套餐");
      const response = await fetch("/api/admin/cards/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: batchForm.name,
          quantity: Number.parseInt(batchForm.quantity, 10),
          benefit,
          expiresAt: batchForm.expiresAt ? new Date(batchForm.expiresAt).getTime() : null,
          salesChannel: batchForm.salesChannel,
          externalBatchId: batchForm.externalBatchId,
          remark: batchForm.remark,
        }),
      });
      const payload = (await response.json()) as { error?: string; batchNo?: string; name?: string; cards?: Array<{ code: string }> };
      if (!response.ok || !payload.cards) throw new Error(errorText(payload, "卡密批次生成失败"));
      setGenerated({ batchNo: payload.batchNo ?? "", name: payload.name ?? batchForm.name, cards: payload.cards });
      setBatchForm(EMPTY_BATCH);
      setMessage(`✓ 已生成 ${payload.cards.length} 张卡密；明文只在本次响应中显示，请立即下载保存`);
      await reloadBatches(1);
      await reloadSummary();
    } catch (error) {
      setMessage(`⚠ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function showDetail(batchId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/cards/batches/${batchId}?page=1&pageSize=50`, { cache: "no-store" });
      const payload = (await response.json()) as { error?: string; batch: BatchItem; stats: Record<string, number>; cards: Array<{ id: string; codePrefix: string; codeLast4: string; status: string; redeemedAt: number | null; username: string | null }> };
      if (!response.ok) throw new Error(errorText(payload, "批次读取失败"));
      setDetail(payload);
    } catch (error) {
      setMessage(`⚠ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function disableBatch(batch: BatchItem) {
    if (!window.confirm(`确认停用批次「${batch.name}」？未兑换卡密将全部失效。`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/cards/batches/${batch.id}/disable`, { method: "POST" });
      if (!response.ok) throw new Error(errorText(await response.json(), "批次停用失败"));
      setMessage("✓ 批次已停用");
      await reloadBatches(pagination.page);
      await reloadSummary();
      if (detail?.batch.id === batch.id) setDetail(null);
    } catch (error) {
      setMessage(`⚠ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function disableCard(cardId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/cards/${cardId}/disable`, { method: "POST" });
      if (!response.ok) throw new Error(errorText(await response.json(), "卡密停用失败"));
      if (detail) await showDetail(detail.batch.id);
      await reloadBatches(pagination.page);
    } catch (error) {
      setMessage(`⚠ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function createApiKey() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/cards/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...keyForm,
          ipAllowlist: keyForm.ipAllowlist,
          rateLimitPerMinute: Number.parseInt(keyForm.rateLimitPerMinute, 10),
          expiresAt: keyForm.expiresAt ? new Date(keyForm.expiresAt).getTime() : null,
        }),
      });
      const payload = (await response.json()) as { error?: string; token?: string; webhookSecret?: string | null };
      if (!response.ok || !payload.token) throw new Error(errorText(payload, "API Key 创建失败"));
      setNewKeySecret({ token: payload.token, webhookSecret: payload.webhookSecret ?? null });
      setKeyForm(EMPTY_KEY);
      setMessage("✓ API Key 已创建；明文凭据只显示一次，请立即保存");
      await reloadKeys();
    } catch (error) {
      setMessage(`⚠ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(item: ApiKeyItem) {
    if (!window.confirm(`确认吊销 API Key「${item.name}」？`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/cards/api-keys/${item.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(errorText(await response.json(), "API Key 吊销失败"));
      await reloadKeys();
      setMessage("✓ API Key 已吊销");
    } catch (error) {
      setMessage(`⚠ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function downloadCodes() {
    if (!generated) return;
    const content = ["卡密,批次号,批次名称", ...generated.cards.map((card) => `${card.code},${generated.batchNo},${generated.name}`)].join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${generated.batchNo}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-10">
      <section>
        <p className="text-xs leading-relaxed text-ink-soft">
          卡密明文只在生成成功时返回，数据库仅保存 HMAC 摘要。兑换会同时写入用户余额、点数明细、订单和审计记录；外部销售系统通过 API Key 调用。
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {([
            ["systemEnabled", "启用卡密系统", "总开关关闭时，用户兑换与外部 API 均不可用"],
            ["redeemEnabled", "开放用户兑换", "控制登录用户是否可以在充值中心兑换"],
            ["apiEnabled", "开放外部 API", "控制外部销售系统生成/查询卡密"],
          ] as const).map(([key, label, hint]) => (
            <label key={key} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-paper-card p-4">
              <input type="checkbox" className="mt-1 accent-[#d51f3a]" checked={settings[key]} disabled={busy} onChange={(event) => void updateSetting(key, event.target.checked)} />
              <span>
                <span className="block text-sm font-bold">{label}</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-ink-faint">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["批次", summaryView.batchCount],
            ["卡密总数", summaryView.cardCount],
            ["可兑换", summaryView.active],
            ["已兑换", summaryView.redeemed],
            ["已停用", summaryView.disabled],
            ["已过期", summaryView.expired],
            ["已发点数", summaryView.redeemedCredits],
            ["兑换订单", summaryView.redeemedOrders],
          ].map(([label, value]) => <div key={label} className="rounded-xl border border-line bg-paper-card px-4 py-3"><div className="font-mono text-xl font-bold">{value}</div><div className="mt-0.5 text-xs text-ink-faint">{label}</div></div>)}
        </div>
      </section>

      <section>
        <div className="rule-double mb-3 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-base font-bold">生成卡密批次</h2>
          <span className="kicker">后台生成 · 一次显示明文</span>
        </div>
        <div className="rounded-xl border border-line bg-paper-card p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input className="field-input" placeholder="批次名称" value={batchForm.name} onChange={(event) => setBatchForm({ ...batchForm, name: event.target.value })} />
            <select className="field-input" value={batchForm.type} onChange={(event) => setBatchForm({ ...batchForm, type: event.target.value as typeof batchForm.type })}>
              <option value="credits">点数卡</option>
              <option value="subscription">会员卡</option>
              <option value="combo">会员 + 点数</option>
            </select>
            {batchForm.type !== "credits" ? (
              <select className="field-input" value={batchForm.planId} onChange={(event) => setBatchForm({ ...batchForm, planId: event.target.value })}>
                <option value="">选择会员套餐</option>
                {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {plan.creditsPerPeriod}点/{plan.periodDays}天</option>)}
              </select>
            ) : <span />}
            {batchForm.type !== "subscription" && <input className="field-input" placeholder={batchForm.type === "combo" ? "额外点数" : "点数"} value={batchForm.credits} onChange={(event) => setBatchForm({ ...batchForm, credits: event.target.value })} />}
            <input className="field-input" type="number" min="1" max="1000" placeholder="数量" value={batchForm.quantity} onChange={(event) => setBatchForm({ ...batchForm, quantity: event.target.value })} />
            <input className="field-input" type="datetime-local" title="过期时间（留空为长期有效）" value={batchForm.expiresAt} onChange={(event) => setBatchForm({ ...batchForm, expiresAt: event.target.value })} />
            <input className="field-input" placeholder="销售渠道（可选）" value={batchForm.salesChannel} onChange={(event) => setBatchForm({ ...batchForm, salesChannel: event.target.value })} />
            <input className="field-input" placeholder="外部批次号（可选）" value={batchForm.externalBatchId} onChange={(event) => setBatchForm({ ...batchForm, externalBatchId: event.target.value })} />
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <input className="field-input min-w-[280px] flex-1" placeholder="备注（可选）" value={batchForm.remark} onChange={(event) => setBatchForm({ ...batchForm, remark: event.target.value })} />
            <button className="btn-ink px-5 py-2 font-mono text-xs" disabled={busy || !batchForm.name || (batchForm.type !== "credits" && !batchForm.planId)} onClick={() => void createBatch()}>生成卡密</button>
          </div>
        </div>
        {generated && (
          <div className="mt-4 rounded-xl border border-[#6d342b] bg-[#2a1717] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><div className="font-bold">已生成 {generated.cards.length} 张卡密</div><div className="mt-1 font-mono text-[11px] text-ink-faint">{generated.batchNo} · {generated.name}</div></div>
              <button className="btn-ink px-4 py-2 font-mono text-xs" onClick={downloadCodes}>下载 CSV</button>
            </div>
            <textarea className="field-input mt-3 min-h-40 w-full font-mono text-xs" readOnly value={generated.cards.map((card) => card.code).join("\n")} />
            <p className="mt-2 text-[11px] text-seal">请立即保存明文。关闭或刷新页面后，系统无法再次找回完整卡密。</p>
          </div>
        )}
      </section>

      <section>
        <div className="rule-double mb-3 flex items-baseline justify-between pt-2"><h2 className="font-display text-base font-bold">卡密批次</h2><span className="kicker">共 {pagination.total} 个</span></div>
        <ul className="space-y-2">
          {batches.map((batch) => (
            <li key={batch.id} className="rounded-xl border border-line bg-paper-card px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-[210px] flex-1"><div className="font-bold">{batch.name} <span className="ml-1 stamp stamp-quiet text-[10px]">{BENEFIT_LABEL[batch.benefitType] ?? batch.benefitType}</span></div><div className="mt-1 font-mono text-[10px] text-ink-faint">{batch.batchNo} · {batch.source === "api" ? "API" : "后台"} · {dateValue(batch.expiresAt)}</div></div>
                <div className="font-mono text-[11px] text-ink-soft">共 {batch.quantity} · 可用 {batch.stats.active ?? 0} · 已兑 {batch.stats.redeemed ?? 0} · 停用 {batch.stats.disabled ?? 0}</div>
                <div className="flex gap-1.5"><button className="btn-ghost px-2.5 py-1 font-mono text-[11px]" disabled={busy} onClick={() => void showDetail(batch.id)}>明细</button>{batch.status === "active" && <button className="btn-ghost px-2.5 py-1 font-mono text-[11px] hover:!border-seal hover:!text-seal" disabled={busy} onClick={() => void disableBatch(batch)}>停用</button>}</div>
              </div>
            </li>
          ))}
          {batches.length === 0 && <li className="rounded-xl border border-dashed border-line-dark px-5 py-8 text-center text-sm text-ink-faint">暂无卡密批次。</li>}
        </ul>
        {pagination.totalPages > 1 && <div className="mt-3 flex justify-between font-mono text-[11px] text-ink-faint"><span>第 {pagination.page} / {pagination.totalPages} 页</span><div className="flex gap-2"><button className="btn-ghost px-3 py-1" disabled={busy || pagination.page <= 1} onClick={() => void reloadBatches(pagination.page - 1)}>上一页</button><button className="btn-ghost px-3 py-1" disabled={busy || pagination.page >= pagination.totalPages} onClick={() => void reloadBatches(pagination.page + 1)}>下一页</button></div></div>}
      </section>

      <section>
        <div className="rule-double mb-3 flex items-baseline justify-between pt-2"><h2 className="font-display text-base font-bold">外部销售 API Key</h2><span className="kicker">HTTPS · 幂等 · 限流</span></div>
        <div className="mb-3 rounded-xl border border-line bg-paper-card px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-soft">
          生成接口：<span className="text-ink">POST /api/v1/cards/generate</span> · 必须携带 <span className="text-ink">Authorization: Bearer aai_live_…</span> 与唯一 <span className="text-ink">Idempotency-Key</span>；接口只返回一次明文卡密。
        </div>
        <div className="rounded-xl border border-line bg-paper-card p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input className="field-input" placeholder="名称" value={keyForm.name} onChange={(event) => setKeyForm({ ...keyForm, name: event.target.value })} />
            <input className="field-input" placeholder="限流（次/分钟）" type="number" min="1" value={keyForm.rateLimitPerMinute} onChange={(event) => setKeyForm({ ...keyForm, rateLimitPerMinute: event.target.value })} />
            <input className="field-input" placeholder="IP 白名单（逗号分隔，可选）" value={keyForm.ipAllowlist} onChange={(event) => setKeyForm({ ...keyForm, ipAllowlist: event.target.value })} />
            <input className="field-input" placeholder="Webhook HTTPS 地址（可选）" value={keyForm.webhookUrl} onChange={(event) => setKeyForm({ ...keyForm, webhookUrl: event.target.value })} />
            <input className="field-input" type="datetime-local" title="过期时间（可选）" value={keyForm.expiresAt} onChange={(event) => setKeyForm({ ...keyForm, expiresAt: event.target.value })} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-soft">
            {(["cards:generate", "cards:read", "cards:disable"] as const).map((scope) => <label key={scope} className="flex items-center gap-1.5"><input type="checkbox" className="accent-[#d51f3a]" checked={keyForm.scopes.includes(scope)} onChange={(event) => setKeyForm({ ...keyForm, scopes: event.target.checked ? [...keyForm.scopes, scope] : keyForm.scopes.filter((item) => item !== scope) })} />{scope}</label>)}
            <button className="btn-ink ml-auto px-5 py-2 font-mono text-xs" disabled={busy || !keyForm.name} onClick={() => void createApiKey()}>创建 API Key</button>
          </div>
        </div>
        {newKeySecret && <div className="mt-4 rounded-xl border border-[#6d342b] bg-[#2a1717] p-4"><div className="font-bold text-seal">请立即保存以下凭据（只显示一次）</div><div className="mt-2 break-all font-mono text-xs">API Key：{newKeySecret.token}</div>{newKeySecret.webhookSecret && <div className="mt-1 break-all font-mono text-xs">Webhook Secret：{newKeySecret.webhookSecret}</div>}</div>}
        <ul className="mt-4 space-y-2">
          {apiKeys.map((item) => <li key={item.id} className="rounded-xl border border-line bg-paper-card px-4 py-3"><div className="flex flex-wrap items-center gap-3"><div className="min-w-[180px] flex-1"><span className="font-bold">{item.name}</span><div className="mt-1 font-mono text-[10px] text-ink-faint">{item.keyPrefix}… · {item.scopes.join(", ")} · {item.rateLimitPerMinute}/分钟</div></div><div className="font-mono text-[10px] text-ink-faint">{item.webhookUrl ? "Webhook 已配置" : "无 Webhook"} · 创建于 {formatBeijingDateTime(item.createdAt)}</div>{item.status === "active" ? <button className="btn-ghost px-2.5 py-1 font-mono text-[11px] hover:!border-seal hover:!text-seal" disabled={busy} onClick={() => void revokeKey(item)}>吊销</button> : <span className="stamp stamp-quiet text-[10px] text-ink-faint">已吊销</span>}</div></li>)}
          {apiKeys.length === 0 && <li className="rounded-xl border border-dashed border-line-dark px-5 py-6 text-center text-sm text-ink-faint">暂无外部 API Key。</li>}
        </ul>
      </section>

      <section>
        <div className="rule-double mb-3 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-base font-bold">Webhook 投递记录</h2>
          <div className="flex items-center gap-3"><span className="kicker">最近 {webhookPaging.total} 条中的 20 条</span><button className="btn-ghost px-2.5 py-1 font-mono text-[11px]" disabled={busy} onClick={() => void reloadWebhooks(webhookPaging.page)}>刷新</button></div>
        </div>
        <ul className="space-y-2">
          {webhooks.map((item) => (
            <li key={item.id} className="rounded-xl border border-line bg-paper-card px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-[220px] flex-1"><div className="font-bold">{item.eventType} <span className="ml-1 stamp stamp-quiet text-[10px]">{WEBHOOK_STATUS_LABEL[item.status] ?? item.status}</span></div><div className="mt-1 truncate font-mono text-[10px] text-ink-faint" title={item.endpointUrl}>{item.endpointUrl}</div></div>
                <div className="font-mono text-[10px] text-ink-faint">尝试 {item.attempts} 次 · {formatBeijingDateTime(item.deliveredAt ?? item.createdAt)}</div>
              </div>
              {item.lastError && <div className="mt-2 truncate font-mono text-[10px] text-seal" title={item.lastError}>{item.lastError}</div>}
            </li>
          ))}
          {webhooks.length === 0 && <li className="rounded-xl border border-dashed border-line-dark px-5 py-6 text-center text-sm text-ink-faint">暂无 Webhook 投递记录。</li>}
        </ul>
        {webhookPaging.totalPages > 1 && <div className="mt-3 flex justify-between font-mono text-[11px] text-ink-faint"><span>第 {webhookPaging.page} / {webhookPaging.totalPages} 页</span><div className="flex gap-2"><button className="btn-ghost px-3 py-1" disabled={busy || webhookPaging.page <= 1} onClick={() => void reloadWebhooks(webhookPaging.page - 1)}>上一页</button><button className="btn-ghost px-3 py-1" disabled={busy || webhookPaging.page >= webhookPaging.totalPages} onClick={() => void reloadWebhooks(webhookPaging.page + 1)}>下一页</button></div></div>}
      </section>

      {message && <p className="font-mono text-xs text-ink-soft">{message}</p>}

      {detail && <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#080706]/85 p-4 backdrop-blur-sm" onClick={() => setDetail(null)}><div className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-[14px] border border-line bg-paper-deep p-6" onClick={(event) => event.stopPropagation()}><div className="rule-double mb-4 flex items-baseline justify-between pt-2"><h3 className="font-display text-lg font-bold">{detail.batch.name}</h3><button className="btn-ghost px-3 py-1 text-xs" onClick={() => setDetail(null)}>关闭</button></div><div className="mb-3 font-mono text-[11px] text-ink-faint">{detail.batch.batchNo} · {detail.batch.quantity} 张 · 可用 {detail.stats.active ?? 0} · 已兑换 {detail.stats.redeemed ?? 0}</div><ul className="grid gap-2 sm:grid-cols-2">{detail.cards.map((card) => <li key={card.id} className="flex items-center justify-between rounded-lg border border-line bg-paper-card px-3 py-2"><div className="font-mono text-xs">{card.codePrefix}…{card.codeLast4}<div className="mt-1 text-[10px] text-ink-faint">{STATUS_LABEL[card.status] ?? card.status}{card.username ? ` · ${card.username}` : ""}{card.redeemedAt ? ` · ${formatBeijingDateTime(card.redeemedAt)}` : ""}</div></div>{card.status === "active" && <button className="btn-ghost px-2 py-1 font-mono text-[10px] hover:!border-seal hover:!text-seal" disabled={busy} onClick={() => void disableCard(card.id)}>停用</button>}</li>)}</ul></div></div>}
    </div>
  );
}
