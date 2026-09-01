import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireAdmin } from "@/server/auth";
import { PayError } from "@/server/pay/service";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  adjusted: "已调整",
  failed: "失败",
  refunded: "已退款",
  expired: "已过期",
  redeemed: "已兑换",
};

/** 订单管理：列表 / 退款 */
export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const runtime = await getRuntime();
  const result = await runtime.orderRepo.listAdminPage({
    status: url.searchParams.get("status") || undefined,
    channel: url.searchParams.get("channel") || undefined,
    q: url.searchParams.get("q")?.trim() || undefined,
    page: Number.parseInt(url.searchParams.get("page") ?? "1", 10),
    pageSize: Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10),
  });
  const userIds = [...new Set(result.items.map((order) => order.userId))];
  const users = userIds.length > 0 ? await runtime.userRepo.listAdmin(undefined, 500) : [];
  const usernames = new Map(users.map((user) => [user.id, user.username]));
  return NextResponse.json({
    orders: result.items.map((order) => ({
      id: order.id,
      orderNo: order.orderNo,
      username: usernames.get(order.userId) ?? order.userId,
      title: order.title,
      type: order.type,
      amountCents: order.amountCents,
      credits: order.credits,
      channel: order.channel,
      status: order.status,
      statusLabel: STATUS_LABEL[order.status] ?? order.status,
      channelTradeNo: order.channelTradeNo,
      failReason: order.failReason,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
    })),
    pagination: {
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    },
  });
}

/** 退款：扣回点数 + 状态置 refunded（渠道侧退款需在商户平台操作） */
export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { orderId?: string; action?: string };
  if (!body.orderId || body.action !== "refund") {
    return NextResponse.json({ error: "orderId 与 action=refund 必填" }, { status: 400 });
  }
  const runtime = await getRuntime();
  const order = await runtime.orderRepo.require(body.orderId);
  try {
    const fresh = await runtime.pay.refundOrder(order);
    return NextResponse.json({ orderId: fresh.id, status: fresh.status });
  } catch (error) {
    if (error instanceof PayError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: String(error).slice(0, 200) }, { status: 500 });
  }
}
