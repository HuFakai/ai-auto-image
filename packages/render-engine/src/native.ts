import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { streamDownloadToFile } from "@aai/ai-core";
import type { GeneratedImage } from "@aai/ai-core";
import sharp from "sharp";

/**
 * Native text mode persistence. The model image IS the final visual, so the
 * server only: streams it to the asset volume, verifies dimensions/format and
 * records metadata — no Satori text compositing.
 */
export async function persistNativeImage(
  image: GeneratedImage,
  destPath: string,
  opts: {
    headers?: Record<string, string>;
    /** Verify output matches the requested aspect ratio within tolerance. */
    expectedRatio?: number;
    signal?: AbortSignal;
  } = {}
): Promise<{ bytes: number; sha256: string; width: number; height: number; mimeType: string; ratioOk: boolean }> {
  if (!image.url && !image.b64) {
    throw new Error("generated image has neither url nor b64 payload");
  }

  let bytes: number;
  let sha256: string;
  if (image.b64) {
    const buf = Buffer.from(image.b64, "base64");
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    bytes = buf.length;
    sha256 = createHash("sha256").update(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)).digest("hex");
  } else {
    const dl = await streamDownloadToFile(image.url!, destPath, {
      headers: opts.headers,
      signal: opts.signal,
    });
    bytes = dl.bytes;
    sha256 = dl.sha256;
  }

  const meta = await sharp(destPath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const ratio = height > 0 ? width / height : 0;
  const ratioOk = opts.expectedRatio ? Math.abs(ratio - opts.expectedRatio) / opts.expectedRatio < 0.05 : true;
  return {
    bytes,
    sha256,
    width,
    height,
    mimeType: meta.format ? `image/${meta.format}` : image.mimeType ?? "image/jpeg",
    ratioOk,
  };
}
