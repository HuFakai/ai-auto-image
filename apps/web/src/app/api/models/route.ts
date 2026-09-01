import { NextResponse } from "next/server";
import { requireApiUser } from "@/server/auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

/** 创作端模型选择目录；ChannelService 已完成渠道开关与密钥脱敏。 */
export async function GET() {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runtime = await getRuntime();
  return NextResponse.json({ models: await runtime.channelService.listSelectableModels() });
}
