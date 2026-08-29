import { NextRequest } from "next/server";

const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ templateId: string; version: string }> },
) {
  try {
    const { templateId, version } = await context.params;
    const body = await request.text();
    const response = await fetch(
      `${apiUrl}/api/resources/hyperframes/templates/${encodeURIComponent(templateId)}/versions/${encodeURIComponent(version)}/preview`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        cache: "no-store",
        signal: request.signal,
      },
    );
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { detail: response.ok ? "预览服务返回了无效数据" : `预览服务异常（${response.status}）` };
    }
    return Response.json(payload, { status: response.status });
  } catch (caught) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return Response.json(
      { detail: caught instanceof Error ? `无法连接预览服务：${caught.message}` : "无法连接预览服务" },
      { status: 502 },
    );
  }
}
