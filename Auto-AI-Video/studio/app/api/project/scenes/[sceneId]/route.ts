import { NextRequest } from "next/server";

const apiUrl = process.env.PIXELLE_API_URL ?? "http://127.0.0.1:18123";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ sceneId: string }> },
) {
  const { sceneId } = await context.params;
  const response = await fetch(
    `${apiUrl}/api/projects/scenes/${encodeURIComponent(sceneId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    },
  );
  return Response.json(await response.json(), { status: response.status });
}
