import { NextRequest } from "next/server";

const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";
const allowedActions = new Set(["approve", "reject", "retry", "cancel"]);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await context.params;
  if (!allowedActions.has(action)) {
    return Response.json({ detail: "Unsupported job action" }, { status: 404 });
  }

  const rawBody = await request.text();
  const response = await fetch(
    `${apiUrl}/api/production/jobs/${encodeURIComponent(id)}/${action}`,
    {
      method: "POST",
      headers: rawBody ? { "Content-Type": "application/json" } : undefined,
      body: rawBody || undefined,
    },
  );
  return Response.json(await response.json(), { status: response.status });
}
