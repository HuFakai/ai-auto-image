import { NextResponse } from "next/server";
import { getDb, getSqlite } from "@/server/db";
import { getProviderConfig } from "@/server/providers";
import { concurrencyConfig } from "@/server/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, unknown> = { status: "ok", time: new Date().toISOString() };
  try {
    const sqlite = getSqlite();
    sqlite.pragma("quick_check");
    checks.sqlite = "ok";
    checks.wal = (sqlite.pragma("journal_mode", { simple: true }) as string) === "wal";
    getDb();
    const { ensureJobRunner } = await import("@/server/runner");
    await ensureJobRunner();
    checks.jobRunner = "running";
  } catch (err) {
    checks.status = "degraded";
    checks.sqlite = err instanceof Error ? err.message : "error";
  }
  const cfg = getProviderConfig();
  checks.providers = { text: Boolean(cfg.text), image: Boolean(cfg.image) };
  checks.concurrency = concurrencyConfig();
  checks.memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  return NextResponse.json(checks, { status: checks.status === "ok" ? 200 : 503 });
}
