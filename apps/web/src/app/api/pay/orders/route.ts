import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireApiUser, userActionLimit } from "@/server/auth";
import { PayError } from "@/server/pay/service";

export const dynamic = "force-dynamic";

type PayChannel = "alipay" | "wechat" | "mock";

const CHANNELS: PayChannel[] = ["alipay", "wechat"];

/** 创建支付订单（返回二维码内容）；GET 查询我的订单 */
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!userActionLimit(`pay-order:${user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const type = body.type === "subscription" ? "subscription" : body.type === "credits" ? "credits" : null;
  const channel = CHANNELS.includes(body.channel as PayChannel) ? (body.channel as PayChannel) : null;
  if (!type || !channel) {
    return NextResponse.json({ error: "type 必须为 subscription|credits，channel 必须为 alipay|wechat" }, { status: 400 });
  }

  const runtime = await getRuntime();
  try {
    const { order, mock } = await runtime.pay.createOrder({
      userId: user.id,
      type,
      planId: typeof body.planId === "string" ? body.planId : undefined,
      packageId: typeof body.packageId === "string" ? body.packageId : undefined,
      channel,
    });
    return NextResponse.json(
      {
        orderId: order.id,
        orderNo: order.orderNo,
        title: order.title,
        amountCents: order.amountCents,
        credits: order.credits,
        channel: order.channel,
        qrCode: order.qrCode,
        expiresAt: order.expiresAt,
        mock,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof PayError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: String(error).slice(0, 200) }, { status: 500 });
  }
}

export async function GET() {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runtime = await getRuntime();
  const orders = await runtime.orderRepo.listByUser(user.id, 20);
  return NextResponse.json({
    orders: orders.map((order) => ({
      id: order.id,
      orderNo: order.orderNo,
      title: order.title,
      type: order.type,
      amountCents: order.amountCents,
      credits: order.credits,
      channel: order.channel,
      status: order.status,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
    })),
  });
}
