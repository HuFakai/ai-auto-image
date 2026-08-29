import { describe, expect, it } from "vitest";
import { extractGeneratedImages } from "./image-extract";

describe("extractGeneratedImages", () => {
  it("extracts b64_json data items", () => {
    const images = extractGeneratedImages({ data: [{ b64_json: "QUJD" }], id: "req_1" });
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ source: "base64", base64: "QUJD", providerRequestId: "req_1" });
  });

  it("extracts url data items", () => {
    const images = extractGeneratedImages({ data: [{ url: "https://cdn.example.com/a.png" }] });
    expect(images[0]).toMatchObject({ source: "url", remoteUrl: "https://cdn.example.com/a.png" });
  });

  it("falls back to a top-level url for non-standard services", () => {
    const images = extractGeneratedImages({ url: "https://cdn.example.com/b.jpg" });
    expect(images[0]).toMatchObject({ source: "url", mimeType: "image/jpeg" });
  });

  it("falls back to a top-level images array", () => {
    const images = extractGeneratedImages({ images: ["https://x/y.png", "QUJD"] });
    expect(images).toHaveLength(2);
    expect(images[0]?.source).toBe("url");
    expect(images[1]?.source).toBe("base64");
  });

  it("returns empty for garbage", () => {
    expect(extractGeneratedImages(null)).toEqual([]);
    expect(extractGeneratedImages({ data: [] })).toEqual([]);
  });
});
