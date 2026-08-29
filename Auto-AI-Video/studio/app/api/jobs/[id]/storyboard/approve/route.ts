import { NextRequest } from "next/server";

const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const rawBody = await request.text();
  const response = await fetch(
    `${apiUrl}/api/production/jobs/${encodeURIComponent(id)}/storyboard/approve`,
    {
      method: "POST",
      headers: rawBody ? { "Content-Type": "application/json" } : undefined,
      body: rawBody || undefined,
    },
  );
  return Response.json(await response.json(), { status: response.status });
}
