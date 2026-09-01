import { NextResponse } from "next/server";
import { cardErrorResponse } from "@/server/card-api";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = await getRuntime();
  try {
    const auth = await runtime.cardSystem.authenticateExternal(request, "cards:read");
    const matched = await runtime.cardRepo.findCardByIdForApi(id, auth.apiKey.id);
    if (!matched) return NextResponse.json({ error: "卡密不存在", code: "NOT_FOUND" }, { status: 404 });
    const expiresAt = matched.card.expiresAt ?? matched.batch.expiresAt;
    const expired = matched.card.status === "active" && expiresAt !== null && expiresAt !== undefined && expiresAt <= Date.now();
    return NextResponse.json({
      card: {
        id: matched.card.id,
        codePrefix: matched.card.codePrefix,
        codeLast4: matched.card.codeLast4,
        status: expired ? "expired" : matched.card.status,
        expiresAt,
        redeemedAt: matched.card.redeemedAt,
        redemptionOrderId: matched.card.redemptionOrderId,
        batchNo: matched.batch.batchNo,
        externalBatchId: matched.batch.externalBatchId,
      },
    });
  } catch (error) {
    const result = cardErrorResponse(error, "卡密查询失败");
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
}
