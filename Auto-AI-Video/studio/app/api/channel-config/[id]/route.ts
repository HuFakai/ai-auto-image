import { NextRequest } from "next/server";

const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = await request.text();
  const response = await fetch(
    `${apiUrl}/api/production/channels/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    },
  );
  return Response.json(await response.json(), { status: response.status });
}
