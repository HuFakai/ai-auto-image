import { NextRequest } from "next/server";

const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  try {
    const response = await fetch(
      `${apiUrl}/api/production/jobs/${encodeURIComponent(id)}/storyboard/redirect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
        cache: "no-store",
      },
    );
    const raw = await response.text();
    try {
      return Response.json(JSON.parse(raw), { status: response.status });
    } catch {
      return Response.json(
        { detail: `API 返回了无效响应（HTTP ${response.status}）` },
        { status: 502 },
      );
    }
  } catch (error) {
    return Response.json(
      { detail: `无法连接 API：${error instanceof Error ? error.message : "未知错误"}` },
      { status: 502 },
    );
  }
}
