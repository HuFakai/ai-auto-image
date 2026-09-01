import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth";
import { ChannelModelSettingsSchema } from "@/server/channel-service";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

const SaveModelsSchema = z.object({
  models: z.array(ChannelModelSettingsSchema).max(200),
});

async function adminOnly() {
  return requireAdmin();
}

/** 读取已经保存的模型目录。 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await adminOnly();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const runtime = await getRuntime();
  try {
    return NextResponse.json({ channel: await runtime.channelService.get(id) });
  } catch {
    return NextResponse.json({ error: "channel not found" }, { status: 404 });
  }
}

/** 从渠道的 /models 接口获取目录；发现的新模型默认不启用。 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await adminOnly();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const runtime = await getRuntime();
  try {
    return NextResponse.json(await runtime.channelService.discoverModels(id));
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : "获取模型失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/** 保存模型启用、默认、优先级、单次点数和能力配置。 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await adminOnly();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = SaveModelsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid input", issues: parsed.error.issues.slice(0, 6) },
      { status: 400 },
    );
  }
  const runtime = await getRuntime();
  try {
    const channel = await runtime.channelService.saveModels(id, parsed.data.models);
    await runtime.refreshChannels();
    return NextResponse.json({ channel });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存模型配置失败";
    return NextResponse.json(
      { error: message.includes("not found") ? "模型不存在或不属于该渠道" : "保存模型配置失败" },
      { status: message.includes("not found") ? 404 : 400 },
    );
  }
}
