import { describe, expect, it } from "vitest";
import { knowledgeCardTheme } from "./theme";
import { estimateLineWidth, fitFontSize } from "./render";

describe("estimateLineWidth", () => {
  it("counts CJK as full width and ASCII as ~0.55", () => {
    expect(estimateLineWidth("你好", 100)).toBe(200);
    expect(estimateLineWidth("abcd", 100)).toBe(220);
  });
});

describe("fitFontSize", () => {
  it("keeps the start size when everything fits", () => {
    expect(fitFontSize(["短标题"], 2000, 140, 40)).toBe(140);
  });

  it("shrinks until the longest line fits", () => {
    const line = "一".repeat(30);
    const size = fitFontSize([line], 1242 * 0.84, 140, 20);
    expect(estimateLineWidth(line, size)).toBeLessThanOrEqual(1242 * 0.84);
  });

  it("throws when even the minimum size overflows", () => {
    const line = "一".repeat(100);
    expect(() => fitFontSize([line], 1000, 140, 20)).toThrow(/text overflow/);
  });
});

describe("knowledgeCardTheme", () => {
  it("pins the template version for snapshot freezing", () => {
    expect(knowledgeCardTheme.templateVersion).toBe("darkroom-knowledge@1");
  });
});
