import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { cardErrorResponse, parseOptionalEpoch, readMetadata, readObject, readOptionalString, readString, resolveCardBenefit, positiveInteger } from "@/server/card-api";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = `req_${randomBytes(10).toString("hex")}`;
  const runtime = await getRuntime();
  try {
    const auth = await runtime.cardSystem.authenticateExternal(request, "cards:generate");
    let body: Record<string, unknown>;
    try {
      body = readObject(await request.json());
    } catch (error) {
      const result = cardErrorResponse(error, "请求格式不正确");
      return NextResponse.json({ requestId, error: result.error, code: result.code }, { status: result.status });
    }
    const name = readString(body.name, "name", 100);
    const quantity = positiveInteger(body.quantity, "quantity", 100);
    const benefit = await resolveCardBenefit(runtime, body.benefit);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    const result = await runtime.cardSystem.generateExternalBatch({
      name,
      quantity,
      benefit,
      expiresAt: parseOptionalEpoch(body.expiresAt),
      salesChannel: readOptionalString(body.salesChannel, 80),
      externalBatchId: readOptionalString(body.externalBatchId, 120),
      remark: readOptionalString(body.remark, 500),
      metadata: readMetadata(body.metadata),
      apiKeyId: auth.apiKey.id,
      idempotencyKey,
      requestBody: body,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const result = cardErrorResponse(error, "卡密批次生成失败");
    const response = NextResponse.json({ requestId, error: result.error, code: result.code }, { status: result.status });
    if (result.status === 429) response.headers.set("Retry-After", "60");
    return response;
  }
}
