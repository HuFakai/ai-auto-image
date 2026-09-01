import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth";
import { cardErrorResponse, parseOptionalEpoch, positiveInteger, readMetadata, readObject, readOptionalString, readString, resolveCardBenefit } from "@/server/card-api";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

function parsePage(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function viewBatch(runtime: Awaited<ReturnType<typeof getRuntime>>, row: Awaited<ReturnType<Awaited<ReturnType<typeof getRuntime>>["cardRepo"]["listBatches"]>>["items"][number]) {
  let benefit: unknown = null;
  try { benefit = JSON.parse(row.benefitJson) as unknown; } catch { /* 损坏快照仍允许管理端查看 */ }
  const stats = await runtime.cardRepo.batchStats(row.id);
  return { ...row, benefit, stats };
}

export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const runtime = await getRuntime();
  const result = await runtime.cardRepo.listBatches({
    page: parsePage(url.searchParams.get("page"), 1),
    pageSize: parsePage(url.searchParams.get("pageSize"), 20),
    q: url.searchParams.get("q")?.trim() || undefined,
    status: url.searchParams.get("status") || undefined,
    source: url.searchParams.get("source") || undefined,
  });
  return NextResponse.json({
    batches: await Promise.all(result.items.map((row) => viewBatch(runtime, row))),
    pagination: { total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages },
  });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const body = readObject(await request.json());
    const runtime = await getRuntime();
    const name = readString(body.name, "批次名称", 100);
    const quantity = positiveInteger(body.quantity, "quantity", 1000);
    const benefit = await resolveCardBenefit(runtime, body.benefit);
    const result = await runtime.cardSystem.generateAdminBatch({
      name,
      quantity,
      benefit,
      expiresAt: parseOptionalEpoch(body.expiresAt),
      salesChannel: readOptionalString(body.salesChannel, 80),
      externalBatchId: readOptionalString(body.externalBatchId, 120),
      remark: readOptionalString(body.remark, 500),
      metadata: readMetadata(body.metadata),
      actorId: admin.id,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const result = cardErrorResponse(error, "批次生成失败");
    return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  }
}
