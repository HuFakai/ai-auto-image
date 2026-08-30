import { NextResponse } from "next/server";
import { z } from "zod";
import { getRuntime } from "@/server/runtime";
import { requireApiUser, userActionLimit } from "@/server/auth";

export const dynamic = "force-dynamic";

const SelectCoverSchema = z.object({ assetId: z.string().min(1) });

/** 挑选作品封面（POST）：校验资产归属与 kind 后写入 workflow_runs.selected_cover_asset_id */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!userActionLimit(`cover-select:${user.id}`, 6, 60_000)) {
    return NextResponse.json(
      { error: "操作过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = SelectCoverSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid assetId" }, { status: 400 });
  }

  const runtime = await getRuntime();
  let run;
  try {
    run = await runtime.runRepo.require(id);
  } catch {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }
  if (run.userId && run.userId !== user.id && user.role !== "admin") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let asset;
  try {
    asset = await runtime.assetRepo.require(parsed.data.assetId);
  } catch {
    return NextResponse.json({ error: "asset not found" }, { status: 404 });
  }
  if (asset.runId !== id) {
    return NextResponse.json({ error: "asset not in this run" }, { status: 400 });
  }
  if (asset.kind !== "cover") {
    return NextResponse.json({ error: "asset is not a cover candidate" }, { status: 400 });
  }

  const updated = await runtime.runRepo.setSelectedCover(id, asset.id);
  return NextResponse.json({ selectedCoverAssetId: updated.selectedCoverAssetId });
}
