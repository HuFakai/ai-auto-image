import { describe, expect, it } from "vitest";
import {
  applyBrandOverlays,
  hasBrandOverlays,
  shrinkTextToFit,
} from "./brand-overlays";

describe("brand overlays", () => {
  it("does not process assets when no watermark or signature is configured", async () => {
    const input = Buffer.from("asset");

    await expect(applyBrandOverlays(input, undefined)).resolves.toBe(input);
    expect(hasBrandOverlays({ footerSignature: " ", watermarkText: "" })).toBe(false);
  });

  it("keeps long brand text within the configured width", () => {
    const result = shrinkTextToFit("品牌名称 Brand", 32, 12, 120);

    expect(result.text.length).toBeLessThanOrEqual("品牌名称 Brand".length);
    expect(result.fontSize).toBeLessThan(32);
    expect(result.fontSize).toBeGreaterThanOrEqual(12);
  });
});
