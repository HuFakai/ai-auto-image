import { NextResponse } from "next/server";
import { requireApiUser } from "@/server/auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const settings = await (await getRuntime()).cardSystem.settings();
  return NextResponse.json({ enabled: settings.systemEnabled && settings.redeemEnabled });
}
