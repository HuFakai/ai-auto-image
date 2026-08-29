import { NextResponse } from "next/server";
import { z } from "zod";
import { getRuntime } from "@/server/runtime";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

const ReorderSchema = z.object({ ids: z.array(z.string()).min(1) });

export async function POST(request: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ReorderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }
  const runtime = await getRuntime();
  await runtime.channelService.reorder(parsed.data.ids);
  await runtime.refreshChannels();
  return NextResponse.json({ ok: true });
}
