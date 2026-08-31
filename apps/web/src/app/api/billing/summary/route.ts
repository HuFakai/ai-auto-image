import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";

export const dynamic = "force-dynamic";

/** 我的钱包概览 + 最近点数流水 */
export async function GET() {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runtime = await getRuntime();
  const summary = await runtime.billing.summary(user.id);
  const ledger = await runtime.ledgerRepo.listByUser(user.id, 20);
  return NextResponse.json({
    ...summary,
    ledger: ledger.map((row) => ({
      id: row.id,
      delta: row.delta,
      balanceAfter: row.balanceAfter,
      reason: row.reason,
      note: row.note,
      createdAt: row.createdAt,
    })),
  });
}
