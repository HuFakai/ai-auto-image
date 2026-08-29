const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export const dynamic = "force-dynamic";

export async function GET() {
  const response = await fetch(`${apiUrl}/api/production/events`, {
    cache: "no-store",
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok || !response.body) {
    return Response.json({ detail: "Production event stream unavailable" }, { status: 503 });
  }
  return new Response(response.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
