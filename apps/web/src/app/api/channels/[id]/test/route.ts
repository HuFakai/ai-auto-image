import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = await getRuntime();
  try {
    const result = await runtime.channelService.test(id);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "channel not found" }, { status: 404 });
  }
}
