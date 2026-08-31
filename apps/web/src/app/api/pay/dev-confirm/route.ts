import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";
import { isMockPaymentAllowed, PayError } from "@/server/pay/service";

export const dynamic = "force-dynamic";

/** 开发/测试沙箱模拟支付确认；生产环境路由硬关闭。 */
export async function POST(request: Request) {
  if (!isMockPaymentAllowed()) {
    return NextResponse.json({ error: "mock payment disabled" }, { status: 404 });
  }
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { orderId?: string };
  try {
    body = (await request.json()) as { orderId?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.orderId) return NextResponse.json({ error: "orderId required" }, { status: 400 });
  const runtime = await getRuntime();
  const order = await runtime.orderRepo.require(body.orderId).catch(() => null);
  if (!order || order.userId !== user.id) return NextResponse.json({ error: "order not found" }, { status: 404 });
  try {
    const fresh = await runtime.pay.devConfirm(order);
    return NextResponse.json({ orderId: fresh.id, status: fresh.status });
  } catch (error) {
    if (error instanceof PayError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: String(error).slice(0, 200) }, { status: 500 });
  }
}
