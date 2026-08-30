import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { GeneratedImage } from "@aai/shared-schemas";

/** 图片魔数校验表，防止 Provider 返回错误类型的响应体 */
const MAGIC_BYTES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: "image/png", test: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  { mime: "image/jpeg", test: (b) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  {
    mime: "image/webp",
    test: (b) => b.subarray(0, 4).equals(Buffer.from("RIFF")) && b.subarray(8, 12).equals(Buffer.from("WEBP")),
  },
  { mime: "image/gif", test: (b) => b.subarray(0, 4).equals(Buffer.from("GIF8")) },
];

export function detectImageMime(buffer: Buffer): string | null {
  for (const entry of MAGIC_BYTES) {
    if (entry.test(buffer)) return entry.mime;
  }
  return null;
}

export interface SavedAsset {
  filePath: string;
  bytes: number;
  mimeType: string;
  checksum: string;
}

/**
 * 资产文件仓：先写 .part 临时文件再原子 rename，中断的下载永远不会看起来完整。
 */
export class AssetStore {
  constructor(private readonly rootDir: string) {
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  get root(): string {
    return this.rootDir;
  }

  resolve(relPath: string): string {
    const full = path.resolve(this.rootDir, relPath);
    if (!full.startsWith(path.resolve(this.rootDir))) {
      throw new Error(`asset path escapes root: ${relPath}`);
    }
    return full;
  }

  /** 删除某 run 的全部媒体文件（runs/<runId> 目录；含封面候选与返修版本） */
  deleteRunAssets(runId: string): void {
    if (!/^[a-z0-9_]+$/i.test(runId)) throw new Error(`invalid run id: ${runId}`);
    const dir = path.join(this.rootDir, "runs", runId);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** 把 Provider 返回的图片落盘（Base64 或远程 URL 流式下载） */
  async saveGeneratedImage(
    image: Pick<GeneratedImage, "source" | "base64" | "remoteUrl">,
    relPath: string,
  ): Promise<SavedAsset> {
    if (image.source === "base64" || image.base64) {
      if (!image.base64) throw new Error("generated image has no base64 payload");
      const buffer = Buffer.from(image.base64.replace(/^data:[^,]+,/, ""), "base64");
      return this.saveBuffer(buffer, relPath);
    }
    if (image.source === "url" && image.remoteUrl) {
      return this.saveFromUrl(image.remoteUrl, relPath);
    }
    throw new Error(`unsupported generated image source: ${image.source}`);
  }

  /** 流式下载：不把完整大图保存在内存（多图并发时尤为关键） */
  async saveFromUrl(url: string, relPath: string): Promise<SavedAsset> {
    const target = this.resolve(relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const partPath = `${target}.part`;

    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`download failed: HTTP ${response.status} for ${url}`);
    }
    const hash = createHash("sha256");
    const counter = new ByteCounter();
    hash.on("data", () => {});
    const nodeStream = Readable.fromWeb(response.body as never);
    nodeStream.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      counter.add(chunk.length);
    });
    try {
      await pipeline(nodeStream, fs.createWriteStream(partPath));
    } catch (error) {
      fs.rmSync(partPath, { force: true });
      throw error;
    }
    return this.finalize(partPath, target, counter.bytes, hash.digest("hex"));
  }

  async saveBuffer(buffer: Buffer, relPath: string): Promise<SavedAsset> {
    const target = this.resolve(relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const partPath = `${target}.part`;
    fs.writeFileSync(partPath, buffer);
    const checksum = createHash("sha256").update(buffer).digest("hex");
    return this.finalize(partPath, target, buffer.length, checksum);
  }

  private finalize(partPath: string, target: string, bytes: number, checksum: string): SavedAsset {
    if (bytes === 0) {
      fs.rmSync(partPath, { force: true });
      throw new Error(`asset is empty: ${target}`);
    }
    const head = Buffer.alloc(12);
    const fd = fs.openSync(partPath, "r");
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
    const mime = detectImageMime(head);
    if (!mime) {
      fs.rmSync(partPath, { force: true });
      throw new Error(`asset is not a recognized image: ${target}`);
    }
    fs.renameSync(partPath, target);
    return { filePath: target, bytes, mimeType: mime, checksum };
  }
}

class ByteCounter {
  bytes = 0;
  add(n: number) {
    this.bytes += n;
  }
}
