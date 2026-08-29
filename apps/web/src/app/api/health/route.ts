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
      database: process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "pglite(内存)",
      concurrency: {
        default: runtime.config.defaultConcurrency,
        serverMax: runtime.config.serverMaxConcurrency,
        postprocessMax: runtime.config.postprocessMax,
      },
      time: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
