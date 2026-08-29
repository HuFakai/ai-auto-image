import { NextResponse } from "next/server";
import { ChannelPatchSchema } from "@/server/channel-service";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ChannelPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues.slice(0, 6) },
      { status: 400 },
    );
  }
  const runtime = await getRuntime();
  try {
    const channel = await runtime.channelService.update(id, parsed.data);
    await runtime.refreshChannels();
    return NextResponse.json({ channel });
  } catch {
    return NextResponse.json({ error: "channel not found" }, { status: 404 });
  }
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = await getRuntime();
  try {
    await runtime.channelService.delete(id);
    await runtime.refreshChannels();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "channel not found" }, { status: 404 });
  }
}
