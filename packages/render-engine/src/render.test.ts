import { describe, it, expect } from "vitest";
import { buildSlideElement, renderSatoriToPng, detectOverflow, BUILTIN_THEMES, ASPECT_DIMENSIONS } from "./index";
import type { SlidePlan } from "@aai/shared-schemas";

const slide: SlidePlan = {
  index: 0,
  role: "cover",
  headline: "每天喝水的三个误区",
  body: ["健康科普 · 第 1 页"],
  visualIntent: "",
  layoutHint: "",
  revision: 0,
};

describe("deterministic renderer", () => {
  it("renders a Chinese cover card to PNG", async () => {
    const theme = BUILTIN_THEMES["minimal-knowledge"];
    const dims = ASPECT_DIMENSIONS["3:4"];
    const element = buildSlideElement({ slide, theme, width: dims.width, height: dims.height });
    const png = await renderSatoriToPng(element, dims);
    expect(png.length).toBeGreaterThan(10_000);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  }, 30_000);

  it("detects overflow for long content", () => {
    const theme = BUILTIN_THEMES["minimal-knowledge"];
    const dims = ASPECT_DIMENSIONS["3:4"];
    const findings = detectOverflow(
      {
        slide: { ...slide, headline: "一个特别特别长的标题".repeat(10), body: ["很长的一段内容。".repeat(120)] },
        theme,
        width: dims.width,
        height: dims.height,
      },
      { headlineSize: 100, bodySize: 46 }
    );
    expect(findings[0].overflow).toBe(true);
  });
});
