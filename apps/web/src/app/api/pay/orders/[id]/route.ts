import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";

export const dynamic = "force-dynamic";

/** 订单状态轮询：pending 且真实渠道时顺带主动查单（防回调丢失） */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const runtime = await getRuntime();
  const order = await runtime.orderRepo.require(id).catch(() => null);
  if (!order || (order.userId !== user.id && user.role !== "admin")) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }
  let fresh = order;
  try {
    fresh = await runtime.pay.queryAndUpdate(order);
  } catch {
    // 查单失败不影响轮询：等下一次或异步通知
  }
  return NextResponse.json({
    orderId: fresh.id,
    status: fresh.status,
    channel: fresh.channel,
    amountCents: fresh.amountCents,
    credits: fresh.credits,
    title: fresh.title,
    paidAt: fresh.paidAt,
    failReason: fresh.failReason,
  });
}
