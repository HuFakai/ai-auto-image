const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function GET(
  _request: Request,
  context: { params: Promise<{ resource: string; id: string }> },
) {
  const { resource, id } = await context.params;
  const response = await fetch(
    `${apiUrl}/api/production/deletions/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`,
    { cache: "no-store" },
  );
  return Response.json(await response.json(), { status: response.status });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ resource: string; id: string }> },
) {
  const { resource, id } = await context.params;
  const response = await fetch(
    `${apiUrl}/api/production/deletions/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    },
  );
  return Response.json(await response.json(), { status: response.status });
}
