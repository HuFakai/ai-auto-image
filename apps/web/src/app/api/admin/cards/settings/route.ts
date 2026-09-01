import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth";
import { cardErrorResponse, readObject } from "@/server/card-api";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  return NextResponse.json(await runtime.cardSystem.settings());
}

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    body = readObject(await request.json());
  } catch (error) {
    const result = cardErrorResponse(error, "请求格式不正确");
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
  const input = {
    systemEnabled: typeof body.systemEnabled === "boolean" ? body.systemEnabled : undefined,
    redeemEnabled: typeof body.redeemEnabled === "boolean" ? body.redeemEnabled : undefined,
    apiEnabled: typeof body.apiEnabled === "boolean" ? body.apiEnabled : undefined,
  };
  if (input.systemEnabled === undefined && input.redeemEnabled === undefined && input.apiEnabled === undefined) {
    return NextResponse.json({ error: "至少提供一个开关" }, { status: 400 });
  }
  const runtime = await getRuntime();
  return NextResponse.json(await runtime.cardSystem.updateSettings(input, admin.id));
}
