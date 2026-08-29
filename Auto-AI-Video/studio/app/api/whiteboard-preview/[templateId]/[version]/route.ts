import { NextRequest } from "next/server";

const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ templateId: string; version: string }> },
) {
  try {
    const { templateId, version } = await context.params;
    const response = await fetch(
      `${apiUrl}/api/resources/whiteboard/templates/${encodeURIComponent(templateId)}/versions/${encodeURIComponent(version)}/preview`,
      { cache: "no-store", signal: request.signal },
    );
    if (!response.ok) {
      return Response.json({ detail: `白板模板预览不可用（${response.status}）` }, { status: response.status });
    }
    return new Response(await response.arrayBuffer(), {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (caught) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return Response.json(
      { detail: caught instanceof Error ? `无法连接白板预览服务：${caught.message}` : "无法连接白板预览服务" },
      { status: 502 },
    );
  }
}
