"use client";

import { useCallback, useEffect, useState } from "react";
import { formatBeijingDateTime } from "@/lib/time";

interface AdminOrderItem {
  id: string;
  orderNo: string;
  username: string;
  title: string;
  type: string;
  amountCents: number;
  credits: number;
  channel: string;
  status: string;
  statusLabel: string;
  channelTradeNo: string | null;
  failReason: string | null;
  createdAt: number;
  paidAt: number | null;
}

interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const yuan = (cents: number) => (cents / 100).toFixed(2);
const CHANNEL_LABEL: Record<string, string> = { alipay: "支付宝", wechat: "微信支付", mock: "沙箱", admin: "后台调整", card: "卡密兑换" };
const TYPE_LABEL: Record<string, string> = { subscription: "订阅", credits: "点数", admin_adjust: "点数调整", card_redeem: "卡密兑换" };
const STATUSES = ["pending", "paid", "adjusted", "redeemed", "failed", "refunded", "expired"];
const STATUS_LABEL: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  adjusted: "已调整",
  failed: "失败",
  refunded: "已退款",
  expired: "已过期",
  redeemed: "已兑换",
};

export function OrdersView() {
  const [orders, setOrders] = useState<AdminOrderItem[]>([]);
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<PaginationMeta>({ total: 0, page: 1, pageSize: 20, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async (targetPage = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (channel) params.set("channel", channel);
      if (q.trim()) params.set("q", q.trim());
      params.set("page", String(targetPage));
      params.set("pageSize", "20");
      const response = await fetch(`/api/admin/orders?${params.toString()}`, { cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as { orders: AdminOrderItem[]; pagination: PaginationMeta };
        setOrders(payload.orders);
        setPagination(payload.pagination);
        setPage(payload.pagination.page);
      }
    } finally {
      setLoading(false);
    }
  }, [status, channel, q]);

  useEffect(() => {
    void reload(1);
  }, [reload]);

  async function refund(order: AdminOrderItem) {
    if (!window.confirm(`确认退款「${order.title}」¥${yuan(order.amountCents)}（${order.username}）？将扣回 ${order.credits} 点。`)) return;
    setBusyId(order.id);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/orders", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: order.id, action: "refund" }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setMessage(`✓ 订单 ${order.orderNo} 已退款，点数已扣回`);
      await reload(page);
    } catch (caught) {
      setMessage(`⚠ ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select className="field-input max-w-[140px]" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          {STATUSES.map((item) => (
            <option key={item} value={item}>
              {STATUS_LABEL[item]}
            </option>
          ))}
        </select>
        <select className="field-input max-w-[140px]" value={channel} onChange={(event) => setChannel(event.target.value)}>
          <option value="">全部渠道</option>
          <option value="alipay">支付宝</option>
          <option value="wechat">微信支付</option>
          <option value="mock">沙箱模拟</option>
          <option value="card">卡密兑换</option>
        </select>
        <input
          className="field-input max-w-xs"
          placeholder="搜索标题或订单号…"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        {message && <span className="font-mono text-xs text-ink-soft">{message}</span>}
      </div>

      <ul className="space-y-2">
        {orders.map((order) => (
          <li key={order.id} className="rounded-xl border border-line bg-paper-card px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex w-[210px] shrink-0 items-center gap-2.5">
                <span className="font-display min-w-0 truncate text-[15px] font-bold">{order.title}</span>
              </div>
              <div className="min-w-0 flex-1 font-mono text-[11px] text-ink-faint">
                <span className="text-ink">{order.username}</span>
                {" · "}{TYPE_LABEL[order.type] ?? order.type}
                {" · "}{CHANNEL_LABEL[order.channel] ?? order.channel}
                {" · "}
                <span className="text-ink">¥{yuan(order.amountCents)}</span>
                {order.credits > 0 && ` / ${order.credits} 点`}
                <div className="mt-0.5 truncate" title={order.orderNo}>
                  {order.orderNo} · 下单 {formatBeijingDateTime(order.createdAt)}
                  {order.paidAt ? ` · 支付 ${formatBeijingDateTime(order.paidAt)}` : ""}
                  {order.channelTradeNo ? ` · 流水 ${order.channelTradeNo}` : ""}
                </div>
                {order.failReason && <div className="mt-0.5 text-seal">⚠ {order.failReason}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`stamp text-[11px] ${
                    order.status === "paid"
                      ? "text-seal"
                      : order.status === "pending"
                        ? "stamp-quiet text-ink-soft"
                        : "stamp-quiet text-ink-faint"
                  }`}
                >
                  {order.statusLabel}
                </span>
                {order.status === "paid" && (
                  <button
                    className="btn-ghost px-2.5 py-1 font-mono text-[11px] hover:!border-seal hover:!text-seal"
                    disabled={busyId === order.id}
                    onClick={() => void refund(order)}
                  >
                    退款
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
        {!loading && orders.length === 0 && (
          <li className="rounded-xl border border-dashed border-line-dark bg-paper-card/40 px-5 py-8 text-center text-sm text-ink-faint">
            没有匹配的订单。
          </li>
        )}
        {loading && <li className="font-mono text-xs text-ink-faint">加载中…</li>}
      </ul>
      {pagination.totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between gap-3 font-mono text-[11px] text-ink-faint">
          <span>共 {pagination.total} 条 · 第 {pagination.page} / {pagination.totalPages} 页</span>
          <div className="flex gap-2">
            <button
              className="btn-ghost px-3 py-1"
              disabled={loading || page <= 1}
              onClick={() => void reload(page - 1)}
            >
              上一页
            </button>
            <button
              className="btn-ghost px-3 py-1"
              disabled={loading || page >= pagination.totalPages}
              onClick={() => void reload(page + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
