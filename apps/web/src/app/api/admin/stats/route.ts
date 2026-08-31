import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 后台收入/经营概览 */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  const nowMs = Date.now();
  const [revenueAllTime, revenueToday, revenue7d, byChannel, statusCounts, ledgerSums, userCount, orderCount] =
    await Promise.all([
      runtime.orderRepo.revenueByDay(0),
      runtime.orderRepo.revenueByDay(nowMs - DAY_MS),
      runtime.orderRepo.revenueByDay(nowMs - 7 * DAY_MS),
      runtime.orderRepo.revenueByChannel(),
      runtime.orderRepo.statusCounts(),
      runtime.ledgerRepo.sumByReason(),
      runtime.userRepo.count(),
      runtime.orderRepo.countAll(),
    ]);

  const sum = (rows: Array<{ totalCents: number; count: number }>) =>
    rows.reduce((acc, row) => acc + row.totalCents, 0);
  const todayTotal = sum(revenueToday);
  const weekTotal = sum(revenue7d);
  const totalCents = sum(revenueAllTime);
  const byReason = Object.fromEntries(ledgerSums.map((row) => [row.reason, row.total]));

  return NextResponse.json({
    revenue: {
      totalCents,
      todayCents: todayTotal,
      weekCents: weekTotal,
      byChannel: byChannel.map((row) => ({ channel: row.channel, totalCents: row.totalCents, count: row.count })),
      daily: revenueAllTime.slice(-30),
    },
    orders: { total: orderCount, statusCounts },
    users: { total: userCount },
    credits: {
      granted: byReason["purchase"] ?? 0,
      subscriptionGranted: byReason["subscription_grant"] ?? 0,
      consumed: -(byReason["consume"] ?? 0),
      adminAdjust: byReason["admin_adjust"] ?? 0,
    },
  });
}
