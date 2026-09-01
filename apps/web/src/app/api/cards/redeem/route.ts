import { NextResponse } from "next/server";
import { requireApiUser } from "@/server/auth";
import { cardErrorResponse, readObject, readString } from "@/server/card-api";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = readObject(await request.json());
  } catch (error) {
    const result = cardErrorResponse(error, "请求格式不正确");
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }

  try {
    const code = readString(body.code, "卡密", 64);
    const runtime = await getRuntime();
    const outcome = await runtime.cardSystem.redeem(user.id, code, request);
    if (outcome.status === "unavailable") {
      const message = outcome.reason === "redeemed"
        ? outcome.redeemedBy === user.id
          ? `这张卡密已经兑换过${outcome.orderNo ? `，订单号 ${outcome.orderNo}` : ""}`
          : "卡密无效或当前不可用"
        : outcome.reason === "expired"
          ? "卡密已过期"
          : outcome.reason === "disabled" || outcome.reason === "batch_disabled"
            ? "卡密已停用"
            : "卡密无效或当前不可用";
      return NextResponse.json({ error: message, code: `CARD_${outcome.reason.toUpperCase()}`, orderNo: outcome.orderNo ?? null }, { status: 409 });
    }
    void runtime.cardSystem.deliverPendingWebhooks().catch(() => {});
    return NextResponse.json({
      ok: true,
      orderId: outcome.orderId,
      orderNo: outcome.orderNo,
      batchNo: outcome.batchNo,
      credits: outcome.credits,
      balance: outcome.balance,
      benefit: outcome.benefit,
    });
  } catch (error) {
    const result = cardErrorResponse(error, "兑换失败，请稍后重试");
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
}
