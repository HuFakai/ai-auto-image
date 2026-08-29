import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJsonCandidate, generateStructured } from "./structured-output";
import type { TextResult } from "./interfaces";
import { emptyUsage } from "@aai/shared-schemas";


describe("parseJsonCandidate", () => {
  it("parses a bare JSON object", () => {
    expect(parseJsonCandidate('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON inside a fenced code block", () => {
    expect(parseJsonCandidate('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("extracts the object from surrounding prose", () => {
    expect(parseJsonCandidate('好的，结果如下：{"a":1} 请查收。')).toEqual({ a: 1 });
  });

  it("throws when nothing parses", () => {
    expect(() => parseJsonCandidate("no json here")).toThrow();
  });
});

describe("generateStructured", () => {
  const schema = z.object({ title: z.string(), pages: z.number().int().min(1) });

  function textModelOf(responses: string[]) {
    let index = 0;
    return async (): Promise<TextResult> => {
      const text = responses[index] ?? responses[responses.length - 1] ?? "";
      index += 1;
      return { text, usage: emptyUsage() };
    };
  }

  it("validates a good response on the first call", async () => {
    const callModel = vi.fn(textModelOf(['{"title":"卡","pages":3}']));
    const result = await generateStructured({
      schemaName: "Storyboard",
      schema,
      prompt: "生成",
      callModel,
    });
    expect(result.value).toEqual({ title: "卡", pages: 3 });
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("makes one repair call carrying the validation error", async () => {
    const callModel = vi.fn(
      textModelOf(['{"title":"卡"}', '{"title":"卡","pages":4}']),
    );
    const result = await generateStructured({
      schemaName: "Storyboard",
      schema,
      prompt: "生成",
      callModel,
    });
    expect(result.value).toEqual({ title: "卡", pages: 4 });
    expect(callModel).toHaveBeenCalledTimes(2);
    const repairPrompt = (callModel.mock.calls as unknown as string[][])[1]?.[0] ?? "";
    expect(repairPrompt).toContain("PREVIOUS ATTEMPT FAILED VALIDATION");
  });

  it("throws a diagnosable AiError after exhausting repairs", async () => {
    const callModel = textModelOf(["完全不是 JSON"]);
    await expect(
      generateStructured({ schemaName: "S", schema, prompt: "生成", callModel }),
    ).rejects.toThrow(/structured output failed validation/);
  });
});
