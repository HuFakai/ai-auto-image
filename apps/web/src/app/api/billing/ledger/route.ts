import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";

export const dynamic = "force-dynamic";

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 分页查询当前用户点数流水；displayTitle 是作品/调整标题快照。 */
export async function GET(request: Request) {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const page = positiveInt(url.searchParams.get("page"), 1);
  const pageSize = positiveInt(url.searchParams.get("pageSize"), 20);
  const runtime = await getRuntime();
  const result = await runtime.ledgerRepo.listByUserPage(user.id, page, pageSize);
  return NextResponse.json({
    items: result.items.map((row) => ({
      id: row.id,
      delta: row.delta,
      balanceAfter: row.balanceAfter,
      reason: row.reason,
      runId: row.runId,
      displayTitle: row.displayTitle,
      note: row.note,
      createdAt: row.createdAt,
    })),
    pagination: {
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totalPages: result.totalPages,
    },
  });
}
