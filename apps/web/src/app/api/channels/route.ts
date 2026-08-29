import { NextResponse } from "next/server";
import { ChannelInputSchema } from "@/server/channel-service";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const runtime = getRuntime();
  return NextResponse.json({
    channels: runtime.channelService.list(),
    providerMode: runtime.config.providerMode,
    providerLabel: runtime.config.providerLabel,
  });
}

export async function POST(request: Request) {
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
  const runtime = getRuntime();
  const channel = runtime.channelService.create(parsed.data);
  runtime.refreshChannels();
  return NextResponse.json({ channel }, { status: 201 });
}
