import { NextResponse } from "next/server";
import { cardErrorResponse } from "@/server/card-api";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ externalBatchId: string }> }) {
  const { externalBatchId } = await ctx.params;
  const runtime = await getRuntime();
  try {
    const auth = await runtime.cardSystem.authenticateExternal(request, "cards:read");
    const batch = await runtime.cardRepo.findBatchByExternalId(auth.apiKey.id, externalBatchId);
    if (!batch) return NextResponse.json({ error: "批次不存在", code: "NOT_FOUND" }, { status: 404 });
    let benefit: unknown = null;
    try { benefit = JSON.parse(batch.benefitJson) as unknown; } catch { /* no-op */ }
    return NextResponse.json({
      batch: {
        id: batch.id,
        batchNo: batch.batchNo,
        externalBatchId: batch.externalBatchId,
        name: batch.name,
        benefit,
        quantity: batch.quantity,
        status: batch.status,
        expiresAt: batch.expiresAt,
        salesChannel: batch.salesChannel,
        remark: batch.remark,
        createdAt: batch.createdAt,
      },
      stats: await runtime.cardRepo.batchStats(batch.id),
    });
  } catch (error) {
    const result = cardErrorResponse(error, "批次查询失败");
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
}
