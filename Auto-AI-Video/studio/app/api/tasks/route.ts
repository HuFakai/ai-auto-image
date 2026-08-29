const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export const dynamic = "force-dynamic";

export async function GET() {
  const response = await fetch(`${apiUrl}/api/tasks/snapshots?limit=1000`, { cache: "no-store" });
  return Response.json(await response.json(), { status: response.status });
}
