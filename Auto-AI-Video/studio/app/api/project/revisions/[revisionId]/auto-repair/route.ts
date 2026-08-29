const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function POST(
  _request: Request,
  context: { params: Promise<{ revisionId: string }> },
) {
  const { revisionId } = await context.params;
  const response = await fetch(
    `${apiUrl}/api/projects/revisions/${encodeURIComponent(revisionId)}/auto-repair`,
    { method: "POST" },
  );
  return Response.json(await response.json(), { status: response.status });
}
