import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssetStore } from "./asset-store";

/** 1x1 PNG */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("AssetStore", () => {
  it("saves a base64 PNG atomically and detects its mime", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-assets-"));
    const store = new AssetStore(dir);
    const saved = await store.saveBuffer(PNG_1PX, "runs/r1/pages/cover.png");

    expect(saved.mimeType).toBe("image/png");
    expect(saved.bytes).toBe(PNG_1PX.length);
    expect(fs.existsSync(saved.filePath)).toBe(true);
    expect(fs.existsSync(`${saved.filePath}.part`)).toBe(false);
  });

  it("rejects non-image payloads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-assets-"));
    const store = new AssetStore(dir);
    await expect(store.saveBuffer(Buffer.from("not an image"), "x.png")).rejects.toThrow(
      /not a recognized image/,
    );
  });

  it("rejects paths escaping the root", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-assets-"));
    const store = new AssetStore(dir);
    expect(() => store.resolve("../../etc/passwd")).toThrow(/escapes root/);
  });
});
