import { describe, expect, it } from "vitest";
import { ContentBriefSchema, StoryboardSchema, GenerationConcurrencySchema, WorkflowDefinitionSchema } from "./index";

describe("shared schemas", () => {
  it("validates a content brief and applies defaults", () => {
    const brief = ContentBriefSchema.parse({
      topic: "护眼习惯",
      audience: "上班族",
      objective: "educate",
      coreMessage: "20-20-20 法则能缓解视疲劳",
      evidence: [{ claim: "远眺放松睫状肌", confidence: "verified" }],
      tone: ["专业"],
      prohibitedClaims: ["治愈近视"],
    });
    expect(brief.evidence[0].source).toBeUndefined();
    expect(brief.prohibitedClaims).toHaveLength(1);
  });

  it("rejects a storyboard with too many slides", () => {
    const base = {
      title: "t",
      platform: "xiaohongshu",
      aspectRatio: "3:4",
    };
    expect(() => StoryboardSchema.parse({ ...base, slides: [] })).toThrow();
    const slides = Array.from({ length: 13 }, (_, i) => ({
      index: i,
      role: "content",
      headline: "h",
      body: [],
      visualIntent: "v",
      layoutHint: "",
    }));
    expect(() => StoryboardSchema.parse({ ...base, slides })).toThrow();
  });

  it("computes effective concurrency shape", () => {
    const c = GenerationConcurrencySchema.parse({ requested: 8, serverMax: 4, effective: 4, postprocessMax: 1 });
    expect(c.effective).toBeLessThanOrEqual(c.serverMax);
  });

  it("validates workflow definition with limits", () => {
    const wf = WorkflowDefinitionSchema.parse({
      id: "wf1",
      version: 1,
      name: "standard",
      nodes: [{ id: "n1", kind: "input", name: "in" }],
      edges: [],
    });
    expect(wf.limits).toEqual({});
  });
});
