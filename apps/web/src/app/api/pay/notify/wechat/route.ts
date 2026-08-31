import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

/** 微信支付 v3 回调：验签 → AES-GCM 解密 resource → 幂等入账 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers = {
    timestamp: request.headers.get("wechatpay-timestamp") ?? "",
    nonce: request.headers.get("wechatpay-nonce") ?? "",
    signature: request.headers.get("wechatpay-signature") ?? "",
    serial: request.headers.get("wechatpay-serial") ?? "",
  };
  const fail = (message: string, code = "FAIL") =>
    NextResponse.json({ code, message }, { status: code === "SUCCESS" ? 200 : 500 });
  try {
    const runtime = await getRuntime();
    const result = await runtime.pay.handleWechatNotify(headers, rawBody);
    if (result.ok) return NextResponse.json({ code: "SUCCESS", message: "成功" });
    return fail("验签失败");
  } catch (error) {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "wechatpay notify error", error: String(error) }),
    );
    return fail("处理失败");
  }
}

export async function GET() {
  return NextResponse.json({ code: "FAIL", message: "method not allowed" }, { status: 405 });
}
