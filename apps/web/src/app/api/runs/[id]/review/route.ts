import { NextResponse } from "next/server";
import { z } from "zod";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

const ReviewSchema = z.object({
  status: z.enum(["approved", "rejected", "pending"]),
  note: z.string().max(500).optional(),
});

/** 人工评审标记：通过 / 驳回 / 复位 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ReviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }
  const runtime = await getRuntime();
  try {
    const run = await runtime.runRepo.require(id);
    // 审批门：awaiting_approval 的运行由「评审通过」放行（→ succeeded，导出放行）；
    // 驳回则终止（→ cancelled，保留资产可追溯）
    if (run.status === "awaiting_approval") {
      if (parsed.data.status === "approved") {
        await runtime.runRepo.updateStatus(id, "succeeded");
      } else if (parsed.data.status === "rejected") {
        await runtime.runRepo.updateStatus(id, "cancelled", { errorSummary: "审批驳回" });
      }
    }
    const updated = await runtime.runRepo.setReview(id, parsed.data.status, parsed.data.note);
    return NextResponse.json({
      runId: id,
      runStatus: updated.status,
      reviewStatus: updated.reviewStatus,
      reviewNote: updated.reviewNote,
    });
  } catch {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
}
