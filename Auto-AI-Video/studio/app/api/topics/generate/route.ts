import { NextRequest } from "next/server";

const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function POST(request: NextRequest) {
  const response = await fetch(`${apiUrl}/api/production/topics/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
  });
  return Response.json(await response.json(), { status: response.status });
}
