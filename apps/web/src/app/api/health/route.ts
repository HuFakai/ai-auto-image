import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runtime = await getRuntime();
    // 触发一次真实 DB 读取验证连接
    await runtime.jobRepo.list(1);
    return NextResponse.json({
      ok: true,
      provider: runtime.config.providerLabel,
      // 布尔语义字符串，不回显数据库 host（公网反代下防信息泄漏）
      database: "ok",
      modelConcurrency: {
        source: "model-channels",
        default: 0,
      },
      time: new Date().toISOString(),
    });
  } catch (error) {
    // 失败不回显内部错误信息（防信息泄漏），细节只进服务端日志
    console.error("health check failed:", error);
    return NextResponse.json(
      { ok: false, database: "error", error: "unhealthy" },
      { status: 500 },
    );
  }
}
