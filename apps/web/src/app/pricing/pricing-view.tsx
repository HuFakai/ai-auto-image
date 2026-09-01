"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { BillingSummary } from "@/server/billing";
import { formatBeijingDate, formatBeijingDateTime } from "@/lib/time";

export interface PlanItem {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  periodDays: number;
  creditsPerPeriod: number;
  features: string[];
}

export interface PackageItem {
  id: string;
  name: string;
  credits: number;
  bonusCredits: number;
  priceCents: number;
}

export interface OrderItem {
  id: string;
  orderNo: string;
  title: string;
  type: string;
  amountCents: number;
  credits: number;
  channel: string;
  status: string;
  createdAt: number;
  paidAt: number | null;
}

export interface LedgerItem {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  runId: string | null;
  displayTitle: string | null;
  note: string | null;
  createdAt: number;
}

export interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const yuan = (cents: number) => (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);

const CHANNEL_LABEL: Record<string, string> = { alipay: "支付宝", wechat: "微信支付", mock: "沙箱模拟", admin: "后台调整", card: "卡密兑换" };
const STATUS_LABEL: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  adjusted: "已调整",
  failed: "失败",
  refunded: "已退款",
  expired: "已过期",
  redeemed: "已兑换",
};
const REASON_LABEL: Record<string, string> = {
  starter: "注册赠送",
  purchase: "点数充值",
  subscription_grant: "订阅发放",
  consume: "生成消耗",
  admin_adjust: "管理员调整",
  refund: "退款扣回",
  card_redeem: "卡密兑换",
};

type PayChannel = "alipay" | "wechat";

interface PayOrder {
  orderId: string;
  channel: string;
  qrCode: string | null;
  amountCents: number;
  credits: number;
  title: string;
  mock: boolean;
}

export function PricingView({
  username,
  summary,
  plans,
  packages,
  orders,
  ordersPagination,
  ledger,
  ledgerPagination,
  cardRedeemEnabled,
}: {
  username: string;
  summary: BillingSummary;
  plans: PlanItem[];
  packages: PackageItem[];
  orders: OrderItem[];
  ordersPagination: PaginationMeta;
  ledger: LedgerItem[];
  ledgerPagination: PaginationMeta;
  cardRedeemEnabled: boolean;
}) {
  const [wallet, setWallet] = useState(summary);
  const [orderRows, setOrderRows] = useState(orders);
  const [ledgerRows, setLedgerRows] = useState(ledger);
  const [orderPaging, setOrderPaging] = useState(ordersPagination);
  const [ledgerPaging, setLedgerPaging] = useState(ledgerPagination);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [paying, setPaying] = useState<{ kind: "plan" | "package"; id: string; name: string; amountCents: number } | null>(null);
  const [order, setOrder] = useState<PayOrder | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [mockConfirming, setMockConfirming] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [paidFlash, setPaidFlash] = useState(false);
  const [cardCode, setCardCode] = useState("");
  const [redeemingCard, setRedeemingCard] = useState(false);
  const [cardMessage, setCardMessage] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refreshSummary = useCallback(async () => {
    try {
      const response = await fetch("/api/billing/summary", { cache: "no-store" });
      if (response.ok) setWallet((await response.json()) as BillingSummary);
    } catch {
      /* 静默 */
    }
  }, []);

  const loadLedgerPage = useCallback(async (page: number) => {
    setLedgerLoading(true);
    try {
      const response = await fetch(`/api/billing/ledger?page=${page}&pageSize=${ledgerPaging.pageSize}`, { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { items: LedgerItem[]; pagination: PaginationMeta };
      setLedgerRows(payload.items);
      setLedgerPaging(payload.pagination);
    } finally {
      setLedgerLoading(false);
    }
  }, [ledgerPaging.pageSize]);

  const loadOrderPage = useCallback(async (page: number) => {
    setOrdersLoading(true);
    try {
      const response = await fetch(`/api/pay/orders?page=${page}&pageSize=${orderPaging.pageSize}`, { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { orders: OrderItem[]; pagination: PaginationMeta };
      setOrderRows(payload.orders);
      setOrderPaging(payload.pagination);
    } finally {
      setOrdersLoading(false);
    }
  }, [orderPaging.pageSize]);

  /* QR 弹窗打开时轮询订单状态（2s）；支付成功 → 停止轮询 + 刷新余额 */
  useEffect(() => {
    if (!order) {
      stopPolling();
      setQrDataUrl(null);
      setPaidFlash(false);
      return;
    }
    if (order.qrCode) {
      QRCode.toDataURL(order.qrCode, { width: 320, margin: 1, color: { dark: "#1c1916", light: "#ede7da" } })
        .then((url) => setQrDataUrl(url))
        .catch(() => setQrDataUrl(null));
    }
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const response = await fetch(`/api/pay/orders/${order.orderId}`, { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { status: string };
        if (payload.status === "paid") {
          stopPolling();
          setPaidFlash(true);
          void refreshSummary();
          void loadOrderPage(orderPaging.page);
          void loadLedgerPage(ledgerPaging.page);
          setTimeout(() => setOrder(null), 1600);
        }
        if (payload.status === "failed" || payload.status === "expired") {
          stopPolling();
          setOrderError(payload.status === "expired" ? "订单已过期，请重新下单" : "订单失败，请重试");
          setOrder(null);
        }
      } catch {
        /* 下一轮再查 */
      }
    }, 2000);
    return stopPolling;
  }, [order, stopPolling, refreshSummary, loadOrderPage, loadLedgerPage, orderPaging.page, ledgerPaging.page]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOrder(null);
        setPaying(null);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function startPay(channel: PayChannel) {
    if (!paying || creating) return;
    setCreating(true);
    setOrderError(null);
    try {
      const response = await fetch("/api/pay/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: paying.kind === "plan" ? "subscription" : "credits",
          ...(paying.kind === "plan" ? { planId: paying.id } : { packageId: paying.id }),
          channel,
        }),
      });
      const payload = (await response.json()) as PayOrder & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setPaying(null);
      setOrder(payload);
    } catch (caught) {
      setOrderError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  }

  async function mockConfirm() {
    if (!order || mockConfirming) return;
    setMockConfirming(true);
    try {
      const response = await fetch("/api/pay/dev-confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: order.orderId }),
      });
      const payload = (await response.json()) as { status?: string; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setPaidFlash(true);
      void refreshSummary();
      void loadOrderPage(orderPaging.page);
      void loadLedgerPage(ledgerPaging.page);
      setTimeout(() => setOrder(null), 1200);
    } catch (caught) {
      setOrderError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMockConfirming(false);
    }
  }

  async function redeemCard() {
    if (!cardCode.trim() || redeemingCard) return;
    setRedeemingCard(true);
    setCardMessage(null);
    try {
      const response = await fetch("/api/cards/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: cardCode.trim() }),
      });
      const payload = (await response.json()) as { error?: string; credits?: number; balance?: number };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setCardCode("");
      setCardMessage(`✓ 兑换成功，到账 ${payload.credits ?? 0} 点，当前余额 ${payload.balance ?? 0} 点`);
      await Promise.all([refreshSummary(), loadOrderPage(orderPaging.page), loadLedgerPage(ledgerPaging.page)]);
    } catch (caught) {
      setCardMessage(`⚠ ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setRedeemingCard(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1080px] space-y-12 px-[26px] pb-24 pt-8 max-md:px-4">
      {/* 头部：余额（胶片计数）+ 订阅状态 */}
      <section className="rise">
        <p className="kicker">PRICING · 点数与订阅</p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-6">
          <div>
            <h1 className="font-display text-2xl font-bold">充值中心</h1>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-soft">
              你好，{username}。文本和图片模型按渠道配置的单次点数计费（1 点 = 0.1 元）；点数长期有效，订阅每月自动发放。
            </p>
          </div>
          <div className="flex items-end gap-8">
            <div className="rounded-xl border border-line bg-paper-card px-5 py-3.5">
              <div className="font-mono text-[34px] font-bold leading-none tracking-tight">
                {wallet.balance}
                <span className="ml-1 text-sm font-normal text-ink-faint">点</span>
              </div>
              <div className="mt-1.5 font-mono text-[10px] tracking-[0.2em] text-ink-faint">
                CREDITS {String(wallet.balance).padStart(4, "0")}
              </div>
            </div>
            <div className="pb-1 text-xs leading-relaxed text-ink-soft">
              {wallet.subscription ? (
                <>
                  <span className="stamp text-seal">{wallet.subscription.planName}</span>
                  <div className="mt-1.5 font-mono text-[11px] text-ink-faint">
                    每期 {wallet.subscription.creditsPerPeriod} 点 · {formatBeijingDate(wallet.subscription.expiresAt)} 到期
                  </div>
                </>
              ) : (
                <span className="text-ink-faint">暂无订阅 · 按点付费</span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 订阅套餐 */}
      <section className="rise" style={{ animationDelay: "60ms" }}>
        <div className="rule-double mb-4 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-lg font-bold">订阅会员</h2>
          <span className="kicker">每月自动发点</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {plans.map((plan) => {
            const active = wallet.subscription?.planId === plan.id;
            return (
              <div
                key={plan.id}
                className={`rounded-[14px] border bg-paper-card p-6 transition-colors ${
                  active ? "border-seal" : "border-line hover:border-line-dark"
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <h3 className="font-display text-base font-bold">
                    {plan.name}
                    {active && <span className="stamp ml-2 align-middle text-[10px] text-seal">生效中</span>}
                  </h3>
                  <div className="text-right">
                    <span className="font-mono text-xl font-bold text-seal">¥{yuan(plan.priceCents)}</span>
                    <span className="ml-1 font-mono text-[11px] text-ink-faint">/ {plan.periodDays} 天</span>
                  </div>
                </div>
                <p className="mt-1 text-xs text-ink-soft">{plan.description}</p>
                <div className="mt-3 font-mono text-[13px]">
                  每期 <span className="font-bold text-ink">{plan.creditsPerPeriod}</span> 点
                  <span className="ml-1 text-[11px] text-ink-faint">≈ {plan.creditsPerPeriod} 张图</span>
                </div>
                <ul className="mt-3 space-y-1.5 text-xs text-ink-soft">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-1.5">
                      <span className="mt-px text-seal">·</span>
                      {feature}
                    </li>
                  ))}
                </ul>
                <button
                  className="btn-ink mt-4 w-full px-5 py-2 font-mono text-xs tracking-[0.15em]"
                  onClick={() => setPaying({ kind: "plan", id: plan.id, name: plan.name, amountCents: plan.priceCents })}
                >
                  {active ? "续费此套餐" : "订阅"}
                </button>
              </div>
            );
          })}
          {plans.length === 0 && (
            <p className="rounded-xl border border-dashed border-line-dark bg-paper-card/40 px-5 py-8 text-center text-sm text-ink-faint md:col-span-2">
              暂无上架套餐，可直接按点充值。
            </p>
          )}
        </div>
      </section>

      {/* 点数充值 */}
      <section className="rise" style={{ animationDelay: "120ms" }}>
        <div className="rule-double mb-4 flex items-baseline justify-between pt-2">
          <h2 className="font-display text-lg font-bold">点数充值</h2>
          <span className="kicker">一次性买断 · 长期有效</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          {packages.map((pkg) => (
            <div key={pkg.id} className="rounded-[14px] border border-line bg-paper-card p-5 transition-colors hover:border-line-dark">
              <h3 className="font-display text-base font-bold">{pkg.name}</h3>
              <div className="mt-2 font-mono text-[26px] font-bold leading-none">
                {pkg.credits + pkg.bonusCredits}
                <span className="ml-1 text-xs font-normal text-ink-faint">点</span>
              </div>
              {pkg.bonusCredits > 0 && (
                <div className="mt-1.5 font-mono text-[11px] text-seal">含赠送 {pkg.bonusCredits} 点</div>
              )}
              <button
                className="btn-ghost mt-4 w-full px-4 py-2 font-mono text-xs tracking-[0.15em]"
                onClick={() => setPaying({ kind: "package", id: pkg.id, name: pkg.name, amountCents: pkg.priceCents })}
              >
                ¥{yuan(pkg.priceCents)} 购买
              </button>
            </div>
          ))}
          {packages.length === 0 && (
            <p className="rounded-xl border border-dashed border-line-dark bg-paper-card/40 px-5 py-8 text-center text-sm text-ink-faint sm:col-span-3">
              暂无上架点数包。
            </p>
          )}
        </div>
      </section>

      {cardRedeemEnabled && (
        <section className="rise" style={{ animationDelay: "150ms" }}>
          <div className="rule-double mb-4 flex items-baseline justify-between pt-2">
            <h2 className="font-display text-lg font-bold">卡密兑换</h2>
            <span className="kicker">兑换后立即到账</span>
          </div>
          <div className="flex flex-wrap gap-3 rounded-[14px] border border-line bg-paper-card p-5">
            <input
              className="field-input min-w-[260px] flex-1 font-mono uppercase"
              placeholder="输入卡密，例如 AAI-XXXXX-XXXXX-…"
              value={cardCode}
              onChange={(event) => setCardCode(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void redeemCard(); }}
              disabled={redeemingCard}
            />
            <button className="btn-ink px-6 py-2 font-mono text-xs" disabled={redeemingCard || !cardCode.trim()} onClick={() => void redeemCard()}>
              {redeemingCard ? "兑换中…" : "立即兑换"}
            </button>
          </div>
          {cardMessage && <p className={`mt-2 font-mono text-xs ${cardMessage.startsWith("⚠") ? "text-seal" : "text-[#5FA36B]"}`}>{cardMessage}</p>}
        </section>
      )}

      {/* 流水与订单 */}
      <section className="rise grid gap-8 md:grid-cols-2" style={{ animationDelay: "180ms" }}>
        <div>
          <div className="rule-double mb-3 flex items-baseline justify-between pt-2">
            <h2 className="font-display text-base font-bold">点数明细</h2>
            <span className="kicker">共 {ledgerPaging.total} 条</span>
          </div>
          <ul className="space-y-1.5">
            {ledgerRows.map((row) => (
              <li key={row.id} className="flex items-center justify-between rounded-lg border border-line bg-paper-card px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-[13px]" title={row.displayTitle ?? undefined}>
                    {row.displayTitle ?? REASON_LABEL[row.reason] ?? row.reason}
                  </div>
                  <div className="truncate font-mono text-[10px] text-ink-faint">
                    {REASON_LABEL[row.reason] ?? row.reason}
                    {row.note ? ` · ${row.note}` : ""} · {formatBeijingDateTime(row.createdAt)}
                  </div>
                </div>
                <div className="ml-3 shrink-0 text-right font-mono text-sm">
                  <span className={row.delta >= 0 ? "text-[#5FA36B]" : "text-seal"}>
                    {row.delta >= 0 ? "+" : ""}
                    {row.delta}
                  </span>
                  <div className="text-[10px] text-ink-faint">余 {row.balanceAfter}</div>
                </div>
              </li>
            ))}
            {ledgerRows.length === 0 && !ledgerLoading && (
              <li className="rounded-lg border border-dashed border-line-dark px-4 py-6 text-center text-xs text-ink-faint">
                还没有点数变动，去创作第一套图文吧。
              </li>
            )}
          </ul>
          {ledgerPaging.totalPages > 1 && (
            <HistoryPager
              pagination={ledgerPaging}
              loading={ledgerLoading}
              onPageChange={(page) => void loadLedgerPage(page)}
            />
          )}
        </div>
        <div>
          <div className="rule-double mb-3 flex items-baseline justify-between pt-2">
            <h2 className="font-display text-base font-bold">我的订单</h2>
            <span className="kicker">共 {orderPaging.total} 条</span>
          </div>
          <ul className="space-y-1.5">
            {orderRows.map((order) => (
              <li key={order.id} className="flex items-center justify-between rounded-lg border border-line bg-paper-card px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px]">{order.title}</div>
                  <div className="font-mono text-[10px] text-ink-faint">
                    订单号 {order.orderNo} · {CHANNEL_LABEL[order.channel] ?? order.channel} · {formatBeijingDateTime(order.createdAt)}
                  </div>
                </div>
                <div className="ml-3 shrink-0 text-right">
                  <div className="font-mono text-sm">¥{yuan(order.amountCents)}</div>
                  {order.credits !== 0 && (
                    <div className={`font-mono text-[10px] ${order.credits > 0 ? "text-[#5FA36B]" : "text-seal"}`}>
                      {order.credits > 0 ? "+" : ""}{order.credits} 点
                    </div>
                  )}
                  <span
                    className={`stamp text-[10px] ${
                      order.status === "paid" ? "text-seal" : order.status === "pending" ? "stamp-quiet text-ink-faint" : "stamp-quiet text-ink-faint"
                    }`}
                  >
                    {STATUS_LABEL[order.status] ?? order.status}
                  </span>
                </div>
              </li>
            ))}
            {orderRows.length === 0 && (
              <li className="rounded-lg border border-dashed border-line-dark px-4 py-6 text-center text-xs text-ink-faint">
                还没有订单。
              </li>
            )}
          </ul>
          {orderPaging.totalPages > 1 && (
            <HistoryPager
              pagination={orderPaging}
              loading={ordersLoading}
              onPageChange={(page) => void loadOrderPage(page)}
            />
          )}
        </div>
      </section>

      {/* 支付方式选择 */}
      {paying && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#080706]/85 p-4 backdrop-blur-sm" onClick={() => setPaying(null)}>
          <div
            className="w-full max-w-md rounded-[14px] border border-line bg-paper-deep p-7 shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rule-double mb-5 flex items-baseline justify-between pt-2">
              <h3 className="font-display text-xl font-bold">确认订单</h3>
              <span className="kicker">CHECKOUT</span>
            </div>
            <div className="flex items-baseline justify-between rounded-xl border border-line bg-paper-card px-4 py-3.5">
              <span>{paying.name}</span>
              <span className="font-mono text-lg font-bold text-seal">¥{yuan(paying.amountCents)}</span>
            </div>
            <p className="mt-4 field-label">选择支付方式（扫码支付）</p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <button
                className="btn-ghost flex flex-col items-center gap-1.5 py-4"
                disabled={creating}
                onClick={() => void startPay("alipay")}
              >
                <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor">
                  <path d="M21 5.5A2.5 2.5 0 0018.5 3h-13A2.5 2.5 0 003 5.5v13A2.5 2.5 0 005.5 21h13a2.5 2.5 0 002.5-2.5v-13zM12.9 7.6l.9-2.2h2.3l-.6 1.6c2.2.6 4 1.6 5 2.4v9.1c0 .8-.7 1.5-1.5 1.5H5c-.8 0-1.5-.7-1.5-1.5V9.4C5.6 8.5 9 7.6 12.9 7.6z" />
                </svg>
                <span className="font-mono text-xs">{creating ? "下单中…" : "支付宝"}</span>
              </button>
              <button
                className="btn-ghost flex flex-col items-center gap-1.5 py-4"
                disabled={creating}
                onClick={() => void startPay("wechat")}
              >
                <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor">
                  <path d="M9.3 4C5.3 4 2 6.7 2 10.1c0 1.9 1 3.5 2.7 4.7l-.7 2.1 2.4-1.2c.9.2 1.6.4 2.5.4h.4a5.5 5.5 0 01-.2-1.5c0-3.2 3-5.8 6.7-5.8h.4C15.5 6.1 12.7 4 9.3 4zM7 7.4a.9.9 0 110 1.8.9.9 0 010-1.8zm4.8 0a.9.9 0 110 1.8.9.9 0 010-1.8zM22 14.6c0-2.8-2.8-5.1-6.2-5.1s-6.2 2.3-6.2 5.1 2.8 5.1 6.2 5.1c.8 0 1.4-.1 2.1-.3l2 1-.6-1.8c1.7-1 2.7-2.5 2.7-4zm-8.2-1.2a.8.8 0 110-1.6.8.8 0 010 1.6zm4 0a.8.8 0 110-1.6.8.8 0 010 1.6z" />
                </svg>
                <span className="font-mono text-xs">{creating ? "下单中…" : "微信支付"}</span>
              </button>
            </div>
            {orderError && <p className="mt-3 font-mono text-xs text-seal">⚠ {orderError}</p>}
            <div className="mt-5 flex justify-end">
              <button className="btn-ghost px-5 py-2 text-sm" onClick={() => setPaying(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 二维码：显影盘 */}
      {order && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#080706]/88 p-4 backdrop-blur-sm" onClick={() => setOrder(null)}>
          <div
            className="w-full max-w-sm rounded-[14px] border border-line bg-paper-deep p-7 text-center shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rule-double mb-4 flex items-baseline justify-between pt-2 text-left">
              <h3 className="font-display text-lg font-bold">{order.title}</h3>
              <span className="font-mono text-lg font-bold text-seal">¥{yuan(order.amountCents)}</span>
            </div>

            {/* 显影盘：暗盘托底，红色安全灯在等待支付时呼吸 */}
            <div className="relative mx-auto w-fit rounded-xl border border-line-dark bg-[#0d0b0a] p-4">
              <div className="pointer-events-none absolute inset-0 rounded-xl bg-seal/10 animate-pulse" style={{ animationDuration: "2.4s" }} />
              {paidFlash ? (
                <div className="grid h-64 w-64 place-items-center max-md:h-52 max-md:w-52">
                  <span className="stamp rotate-[-8deg] px-4 py-2 text-xl text-seal">已完成</span>
                </div>
              ) : order.mock ? (
                <div className="grid h-64 w-64 place-items-center px-6 text-center max-md:h-52 max-md:w-52">
                  <div>
                    <p className="font-mono text-[11px] leading-relaxed text-ink-soft">
                      沙箱模拟收款
                      <br />
                      （支付渠道未配置，走 mock 流程）
                    </p>
                    <button
                      className="btn-ink mt-4 px-5 py-2 font-mono text-xs tracking-[0.15em]"
                      onClick={() => void mockConfirm()}
                      disabled={mockConfirming}
                    >
                      {mockConfirming ? "确认中…" : "模拟支付成功"}
                    </button>
                  </div>
                </div>
              ) : qrDataUrl ? (
                <img src={qrDataUrl} alt="支付二维码" className="h-64 w-64 rounded-md max-md:h-52 max-md:w-52" />
              ) : (
                <div className="grid h-64 w-64 place-items-center max-md:h-52 max-md:w-52">
                  <span className="font-mono text-xs text-ink-faint">二维码生成中…</span>
                </div>
              )}
            </div>

            <p className="mt-4 text-xs text-ink-soft">
              {order.mock
                ? "确认后点数立即到账。"
                : `打开${CHANNEL_LABEL[order.channel] ?? ""}扫一扫，支付完成自动到账。`}
              <span className="ml-1 text-ink-faint">+{order.credits} 点</span>
            </p>
            {!paidFlash && (
              <button className="btn-ghost mt-4 px-5 py-1.5 font-mono text-[11px]" onClick={() => setOrder(null)}>
                关闭（支付完成后余额自动刷新）
              </button>
            )}
            {orderError && <p className="mt-2 font-mono text-xs text-seal">⚠ {orderError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryPager({
  pagination,
  loading,
  onPageChange,
}: {
  pagination: PaginationMeta;
  loading: boolean;
  onPageChange: (page: number) => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[10px] text-ink-faint">
      <span>
        第 {pagination.page} / {pagination.totalPages} 页
      </span>
      <div className="flex gap-1.5">
        <button
          type="button"
          className="btn-ghost px-2.5 py-1"
          disabled={loading || pagination.page <= 1}
          onClick={() => onPageChange(pagination.page - 1)}
        >
          上一页
        </button>
        <button
          type="button"
          className="btn-ghost px-2.5 py-1"
          disabled={loading || pagination.page >= pagination.totalPages}
          onClick={() => onPageChange(pagination.page + 1)}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
