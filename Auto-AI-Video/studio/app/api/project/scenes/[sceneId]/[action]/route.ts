import { NextRequest } from "next/server";

const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";
const actions = new Set(["split", "merge", "regenerate"]);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sceneId: string; action: string }> },
) {
  const { sceneId, action } = await context.params;
  if (!actions.has(action)) {
    return Response.json({ detail: "Unsupported scene action" }, { status: 404 });
  }
  const response = await fetch(
    `${apiUrl}/api/projects/scenes/${encodeURIComponent(sceneId)}/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    },
  );
  return Response.json(await response.json(), { status: response.status });
}
