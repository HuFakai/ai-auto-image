import { Readable } from "node:stream";
import { getRuntime } from "@/server/runtime";
import { readAssetFile } from "@/server/run-views";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const runtime = await getRuntime();
  const file = await readAssetFile(runtime, id);
  if (!file) return new Response("asset not found", { status: 404 });

  return new Response(Readable.toWeb(file.body) as ReadableStream, {
    headers: {
      "content-type": file.mimeType,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
