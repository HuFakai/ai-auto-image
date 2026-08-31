"use client";

import { useCallback, useEffect, useState } from "react";

interface ChannelState {
  enabled: boolean;
  config: Record<string, string>;
  hasSecrets: boolean;
}

interface Payload {
  alipay: ChannelState;
  wechat: ChannelState;
  envHint: { notifyBaseUrl: string };
}

interface FieldMeta {
  label: string;
  placeholder: string;
  secret?: boolean;
  multiline?: boolean;
}

const FIELD_LABELS: Record<string, Record<string, FieldMeta>> = {
  alipay: {
    appId: { label: "应用 AppID", placeholder: "2021000100000000" },
    gateway: { label: "网关地址", placeholder: "https://openapi.alipay.com/gateway.do（沙箱 openapi-sandbox.dl.alipaydev.com）" },
    appPrivateKey: { label: "应用私钥（PKCS1/PKCS8 PEM 或 base64）", placeholder: "-----BEGIN PRIVATE KEY-----", secret: true, multiline: true },
    alipayPublicKey: { label: "支付宝公钥（验签用）", placeholder: "-----BEGIN PUBLIC KEY-----", secret: true, multiline: true },
  },
  wechat: {
    mchid: { label: "商户号 mchid", placeholder: "1900000000" },
    appid: { label: "AppID（公众号/小程序）", placeholder: "wx1234567890abcdef" },
    serialNo: { label: "商户 API 证书序列号", placeholder: "5157F09EFDC096DE15EBE81A47057A72…" },
    privateKey: { label: "商户私钥（apiclient_key.pem）", placeholder: "-----BEGIN PRIVATE KEY-----", secret: true, multiline: true },
    apiv3Key: { label: "APIv3 密钥（32 位）", placeholder: "32 位密钥", secret: true },
    verifyKeyPem: { label: "微信支付公钥 / 平台证书（回调验签）", placeholder: "-----BEGIN PUBLIC KEY-----", secret: true, multiline: true },
    verifyKeyId: { label: "微信支付公钥 ID（公钥模式，PUB_KEY_ID_ 开头；平台证书模式留空）", placeholder: "PUB_KEY_ID_xxx" },
  },
};

const CHANNEL_TITLE: Record<string, string> = { alipay: "支付宝（当面付·订单码）", wechat: "微信支付（Native 扫码）" };

export function PaymentsView() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const response = await fetch("/api/admin/payment-configs", { cache: "no-store" });
    if (response.ok) {
      const body = (await response.json()) as Payload;
      setPayload(body);
      setDrafts({
        alipay: { ...body.alipay.config },
        wechat: { ...body.wechat.config },
      });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save(channel: string, enabled?: boolean) {
    if (!payload) return;
    setBusy(true);
    setMessage(null);
    try {
      const fields = FIELD_LABELS[channel] ?? {};
      const config: Record<string, string> = {};
      const secrets: Record<string, string | null> = {};
      for (const [field, meta] of Object.entries(fields)) {
        const value = drafts[channel]?.[field] ?? "";
        if (meta.secret) {
          // 密钥字段：显式空串表示清除，未填写则保持不变
          if (value.trim()) secrets[field] = value;
        } else if (value.trim()) {
          config[field] = value.trim();
        }
      }
      const response = await fetch("/api/admin/payment-configs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, ...(enabled !== undefined ? { enabled } : {}), config, secrets }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setMessage(`✓ 已保存${CHANNEL_TITLE[channel]}`);
      await reload();
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!payload) return <p className="font-mono text-xs text-ink-faint">加载中…</p>;

  return (
    <div className="space-y-8">
      <p className="text-xs leading-relaxed text-ink-soft">
        扫码支付下单与回调均走服务端；密钥加密落库、保存后不再回显。异步通知地址取环境变量
        <span className="ml-1 font-mono text-ink">PAY_NOTIFY_BASE_URL</span>
        {payload.envHint.notifyBaseUrl ? (
          <span className="ml-1 font-mono text-[#5FA36B]">（当前：{payload.envHint.notifyBaseUrl}）</span>
        ) : (
          <span className="ml-1 font-mono text-seal">（未设置：真实渠道仍可下单，但建议配置公网地址以接收回调）</span>
        )}
        。渠道参数未配置完整时，下单会自动降级为「沙箱模拟」收款。
      </p>

      {(["alipay", "wechat"] as const).map((channel) => {
        const state = payload[channel];
        const draft = drafts[channel] ?? {};
        const fields = FIELD_LABELS[channel] ?? {};
        return (
          <section key={channel} className="rounded-[14px] border border-line bg-paper-card p-5">
            <div className="rule-double mb-4 flex items-baseline justify-between pt-2">
              <h2 className="font-display text-lg font-bold">{CHANNEL_TITLE[channel]}</h2>
              <div className="flex items-center gap-2">
                <span className={`stamp text-[10px] ${state.enabled ? "text-seal" : "stamp-quiet text-ink-faint"}`}>
                  {state.enabled ? "已启用" : "未启用"}
                </span>
                <span className={`stamp stamp-quiet text-[10px] ${state.hasSecrets ? "text-ink-soft" : "text-ink-faint"}`}>
                  {state.hasSecrets ? "密钥已配置" : "无密钥"}
                </span>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {Object.entries(fields).map(([field, meta]) => (
                <div key={field} className={meta.multiline ? "sm:col-span-2" : ""}>
                  <span className="field-label">
                    {meta.label}
                    {meta.secret && state.hasSecrets && (
                      <span className="ml-2 normal-case tracking-normal text-ink-faint">留空保持不变</span>
                    )}
                  </span>
                  {meta.multiline ? (
                    <textarea
                      className="field-input mt-1 min-h-[96px] font-mono !text-[12px]"
                      placeholder={meta.placeholder}
                      value={draft[field] ?? ""}
                      onChange={(event) =>
                        setDrafts((prev) => ({ ...prev, [channel]: { ...prev[channel], [field]: event.target.value } }))
                      }
                    />
                  ) : (
                    <input
                      className={`field-input mt-1 ${meta.secret ? "font-mono !text-[12px]" : ""}`}
                      placeholder={meta.placeholder}
                      value={draft[field] ?? ""}
                      onChange={(event) =>
                        setDrafts((prev) => ({ ...prev, [channel]: { ...prev[channel], [field]: event.target.value } }))
                      }
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-3">
              <button className="btn-ghost px-4 py-2 text-sm" disabled={busy} onClick={() => void save(channel, !state.enabled)}>
                {state.enabled ? "保存并停用" : "保存并启用"}
              </button>
              <button className="btn-ink px-5 py-2 text-sm" disabled={busy} onClick={() => void save(channel)}>
                {busy ? "保存中…" : "保存参数"}
              </button>
            </div>
          </section>
        );
      })}

      {message && <p className="font-mono text-xs text-ink-soft">{message}</p>}
    </div>
  );
}
