const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function GET() {
  const response = await fetch(`${apiUrl}/api/settings`, { cache: "no-store" });
  return Response.json(await response.json(), { status: response.status });
}

export async function PUT(request: Request) {
  const response = await fetch(`${apiUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
  });
  return Response.json(await response.json(), { status: response.status });
}
