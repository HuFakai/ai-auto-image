import path from "node:path";
import { NextResponse } from "next/server";
import { detectImageMime } from "@aai/storage";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);

/** 图片上传（Brand Kit Logo 等参考素材）：类型/大小/魔数三重检查后入资产库 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form-data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "文件超过 5MB 上限" }, { status: 413 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const mime = detectImageMime(buffer.subarray(0, 12));
  if (!mime || !ALLOWED.has(mime)) {
    return NextResponse.json({ error: `不支持的图片类型：${mime ?? "未知"}` }, { status: 415 });
  }

  const runtime = await getRuntime();
  const safeName = (file.name || "upload").replace(/[\\/:*?"<>|]/g, "").slice(-60) || "upload";
  const saved = await runtime.assetStore.saveBuffer(
    buffer,
    path.join("uploads", `${Date.now()}-${safeName}`),
  );
  const asset = await runtime.assetRepo.create({
    kind: "upload",
    filePath: saved.filePath,
    mimeType: saved.mimeType,
    bytes: saved.bytes,
    checksum: saved.checksum,
    metadataJson: JSON.stringify({ originalName: file.name }),
  });

  return NextResponse.json({ assetId: asset.id, mimeType: saved.mimeType, bytes: saved.bytes }, { status: 201 });
}
