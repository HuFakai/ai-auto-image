import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

function parsePage(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  try {
    const batch = await runtime.cardRepo.requireBatch(id);
    const url = new URL(request.url);
    const cards = await runtime.cardRepo.listCardsPage(id, {
      page: parsePage(url.searchParams.get("page"), 1),
      pageSize: parsePage(url.searchParams.get("pageSize"), 50),
      status: url.searchParams.get("status") || undefined,
      q: url.searchParams.get("q")?.trim() || undefined,
    });
    let benefit: unknown = null;
    try { benefit = JSON.parse(batch.benefitJson) as unknown; } catch { /* no-op */ }
    return NextResponse.json({
      batch: { ...batch, benefit },
      stats: await runtime.cardRepo.batchStats(id),
      cards: cards.items,
      pagination: { total: cards.total, page: cards.page, pageSize: cards.pageSize, totalPages: cards.totalPages },
    });
  } catch {
    return NextResponse.json({ error: "批次不存在" }, { status: 404 });
  }
}
