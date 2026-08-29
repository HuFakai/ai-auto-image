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

  // 归属校验：取资产后确认其所属 run 属于当前用户（或当前用户为 admin），否则一律 404
  let asset;
  try {
    asset = await runtime.assetRepo.require(id);
  } catch {
    return new Response("asset not found", { status: 404 });
  }
  let authorized = false;
  if (asset.runId) {
    try {
      const run = await runtime.runRepo.require(asset.runId);
      authorized = run.userId === user.id || user.role === "admin";
    } catch {
      authorized = false;
    }
  } else {
    // runId 为空的资产（上传素材/manifest）：仅 admin 可读（上传路径本身 admin-only）
    authorized = user.role === "admin";
  }
  if (!authorized) return new Response("asset not found", { status: 404 });

  const file = await readAssetFile(runtime, id);
  if (!file) return new Response("asset not found", { status: 404 });

  return new Response(Readable.toWeb(file.body) as ReadableStream, {
    headers: {
      "content-type": file.mimeType,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
