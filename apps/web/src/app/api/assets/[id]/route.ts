import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { readAssetFile } from "@/server/run-views";
import { requireApiUser } from "@/server/auth";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
