const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";
const actions = new Set(["start", "stop"]);

export async function POST(
  _request: Request,
  context: { params: Promise<{ action: string }> },
) {
  const { action } = await context.params;
  if (!actions.has(action)) {
    return Response.json({ detail: "不支持的 Runner 操作" }, { status: 404 });
  }
  const response = await fetch(`${apiUrl}/api/production/runner/${action}`, {
    method: "POST",
    cache: "no-store",
  });
  const payload = await response.json();
  return Response.json(payload, { status: response.status });
}
