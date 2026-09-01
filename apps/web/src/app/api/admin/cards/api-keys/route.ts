import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth";
import { CARD_SCOPES, CardSystemError } from "@/server/card-system";
import { cardErrorResponse, parseOptionalEpoch, positiveInteger, readObject, readOptionalString, readString, readStringList } from "@/server/card-api";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

function parseJsonList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function viewKey(row: Awaited<ReturnType<Awaited<ReturnType<typeof getRuntime>>["cardRepo"]["listApiKeys"]>>[number]) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: parseJsonList(row.scopesJson),
    ipAllowlist: parseJsonList(row.ipAllowlistJson),
    rateLimitPerMinute: row.rateLimitPerMinute,
    webhookUrl: row.webhookUrl,
    webhookConfigured: Boolean(row.webhookUrl),
    status: row.status,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  return NextResponse.json({ apiKeys: (await runtime.cardRepo.listApiKeys()).map(viewKey) });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const body = readObject(await request.json());
    const scopes = readStringList(body.scopes ?? ["cards:generate"], CARD_SCOPES.length, 40)
      .filter((scope): scope is (typeof CARD_SCOPES)[number] => CARD_SCOPES.includes(scope as (typeof CARD_SCOPES)[number]));
    if (scopes.length === 0) throw new CardSystemError("INVALID_REQUEST", "至少选择一个 API 权限");
    const runtime = await getRuntime();
    const result = await runtime.cardSystem.createApiKey({
      name: readString(body.name, "API Key 名称", 80),
      scopes,
      ipAllowlist: readStringList(body.ipAllowlist, 100, 64),
      rateLimitPerMinute: positiveInteger(body.rateLimitPerMinute ?? 60, "限流值", 10_000),
      webhookUrl: readOptionalString(body.webhookUrl, 500),
      expiresAt: parseOptionalEpoch(body.expiresAt),
      createdBy: admin.id,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const result = cardErrorResponse(error, "API Key 创建失败");
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
}
