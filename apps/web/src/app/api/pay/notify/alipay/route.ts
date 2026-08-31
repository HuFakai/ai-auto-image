import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

/** 支付宝异步通知（form-urlencoded）：验签 → 幂等入账 → 应答 success */
export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    const runtime = await getRuntime();
    const result = await runtime.pay.handleAlipayNotify(rawBody);
    if (result === "success") {
      return new NextResponse("success", { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new NextResponse("fail", { status: 400, headers: { "content-type": "text/plain" } });
  } catch (error) {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "alipay notify error", error: String(error) }),
    );
    return new NextResponse("fail", { status: 500, headers: { "content-type": "text/plain" } });
  }
}

export async function GET() {
  return NextResponse.json({ error: "method not allowed" }, { status: 405 });
}
