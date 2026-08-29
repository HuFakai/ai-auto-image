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
  const runtime = getRuntime();
  try {
    const run = runtime.runRepo.setReview(id, parsed.data.status, parsed.data.note);
    return NextResponse.json({
      runId: id,
      reviewStatus: run.reviewStatus,
      reviewNote: run.reviewNote,
    });
  } catch {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
}
