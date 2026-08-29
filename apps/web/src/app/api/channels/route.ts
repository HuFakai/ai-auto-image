import { NextResponse } from "next/server";
import { ChannelInputSchema } from "@/server/channel-service";
import { getRuntime } from "@/server/runtime";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  return NextResponse.json({
    channels: await runtime.channelService.list(),
    providerMode: runtime.config.providerMode,
    providerLabel: runtime.config.providerLabel,
  });
}

export async function POST(request: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ChannelInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues.slice(0, 6) },
      { status: 400 },
    );
  }
  const runtime = await getRuntime();
  const channel = await runtime.channelService.create(parsed.data);
  await runtime.refreshChannels();
  return NextResponse.json({ channel }, { status: 201 });
}
