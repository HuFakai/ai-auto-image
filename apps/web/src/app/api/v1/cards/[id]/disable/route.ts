import { NextResponse } from "next/server";
import { cardErrorResponse } from "@/server/card-api";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = await getRuntime();
  try {
    const auth = await runtime.cardSystem.authenticateExternal(request, "cards:disable");
    const matched = await runtime.cardRepo.findCardByIdForApi(id, auth.apiKey.id);
    if (!matched) return NextResponse.json({ error: "卡密不存在", code: "NOT_FOUND" }, { status: 404 });
    const changed = await runtime.cardRepo.disableCard(id, null, auth.apiKey.id);
    return changed
      ? NextResponse.json({ ok: true, cardId: id })
      : NextResponse.json({ error: "卡密已不是可停用状态", code: "CARD_NOT_ACTIVE" }, { status: 409 });
  } catch (error) {
    const result = cardErrorResponse(error, "卡密停用失败");
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
}
