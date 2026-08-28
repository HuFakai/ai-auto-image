import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AiError, errorFromStatus } from "./errors";

/**
 * Stream a remote image to disk without holding the whole body in memory.
 * Writes to tmp path then atomically renames, so partial downloads never
 * end up referenced by the assets table.
 */
export async function streamDownloadToFile(
  url: string,
  destPath: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<{ bytes: number; sha256: string; contentType?: string }> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);

  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  const hash = createHash("sha256");
  let bytes = 0;
  let contentType: string | undefined;

  try {
    const res = await fetch(url, { headers: opts.headers, signal: controller.signal });
    if (!res.ok) {
      throw errorFromStatus(res.status, await res.text().catch(() => ""));
    }
    contentType = res.headers.get("content-type") ?? undefined;
    await mkdir(dirname(destPath), { recursive: true });

    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    await pipeline(nodeStream, createWriteStream(tmpPath));
    await rename(tmpPath, destPath);
    return { bytes, sha256: hash.digest("hex"), contentType };
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    if (err instanceof AiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new AiError("timeout", `download timed out or aborted: ${url}`);
    }
    throw new AiError("upstream", `download failed: ${url}`, {
      upstreamBody: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Download a remote asset into memory (small images only). */
export async function downloadToBuffer(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<{ buffer: Buffer; contentType?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, { headers: opts.headers, signal: controller.signal });
    if (!res.ok) {
      throw errorFromStatus(res.status, await res.text().catch(() => ""));
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? undefined };
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new AiError("timeout", `download timed out: ${url}`);
    }
    throw new AiError("upstream", `download failed: ${url}`, {
      upstreamBody: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
