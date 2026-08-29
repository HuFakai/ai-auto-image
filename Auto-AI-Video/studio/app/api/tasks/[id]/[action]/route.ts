const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function POST(_request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await context.params;
  if (action !== "retry") return Response.json({ detail: "Unsupported task action" }, { status: 404 });
  const response = await fetch(`${apiUrl}/api/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" });
  return Response.json(await response.json(), { status: response.status });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await context.params;
  if (action !== "cancel") return Response.json({ detail: "Unsupported task action" }, { status: 404 });
  const response = await fetch(`${apiUrl}/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  return Response.json(await response.json(), { status: response.status });
}
