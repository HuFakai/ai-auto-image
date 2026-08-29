const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q") || "";
  const response = await fetch(`${apiUrl}/api/production/search?q=${encodeURIComponent(query)}`, { cache: "no-store" });
  return Response.json(await response.json(), { status: response.status });
}
