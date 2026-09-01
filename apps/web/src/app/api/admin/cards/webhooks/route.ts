import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const parse = (key: string, fallback: number) => {
    const value = Number.parseInt(url.searchParams.get(key) ?? "", 10);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  const runtime = await getRuntime();
  const result = await runtime.cardRepo.listWebhookDeliveries(parse("page", 1), parse("pageSize", 20));
  return NextResponse.json({
    deliveries: result.items.map((item) => ({
      id: item.id,
      eventId: item.eventId,
      eventType: item.eventType,
      resourceId: item.resourceId,
      endpointUrl: item.endpointUrl,
      status: item.status,
      attempts: item.attempts,
      nextAttemptAt: item.nextAttemptAt,
      lastError: item.lastError,
      deliveredAt: item.deliveredAt,
      createdAt: item.createdAt,
    })),
    pagination: { total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages },
  });
}
