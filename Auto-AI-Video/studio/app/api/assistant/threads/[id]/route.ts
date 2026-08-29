const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const response = await fetch(
    `${apiUrl}/api/production/assistant/threads/${encodeURIComponent(id)}`,
    { cache: "no-store" },
  );
  return Response.json(await response.json(), { status: response.status });
}
