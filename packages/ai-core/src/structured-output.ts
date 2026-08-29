import { emptyUsage, type ModelUsage } from "@aai/shared-schemas";
import { AiError } from "./errors";
import type { TextResult } from "./interfaces";
import { z } from "zod";

/**
 * 结构化输出的共享实现：
 * 1. 把 JSON Schema 注入 Prompt（不依赖 provider 的 JSON mode，兼容所有 OpenAI-compatible 服务）；
 * 2. 三级解析容错：直接 JSON.parse → 提取 ```json 代码块 → 截取首尾大括号；
 * 3. Zod 校验；失败允许一次"带错误信息的修复调用"，仍失败则抛出可诊断错误。
 * （解析策略借鉴 Auto-AI-Video llm_service 的 _parse_response_as_model）
 */
export async function generateStructured<T>(input: {
  schemaName: string;
  schema: z.ZodType<T>;
  system?: string | undefined;
  prompt: string;
  maxRepairCalls?: number | undefined;
  callModel: (prompt: string, system?: string | undefined) => Promise<TextResult>;
}): Promise<{ value: T; usage: ModelUsage; providerRequestId?: string }> {
  const jsonSchema = z.toJSONSchema(input.schema, { io: "output" });
  const instruction = [
    input.prompt,
    "",
    "## IMPORTANT: JSON Output Format Required",
    `Respond with a single JSON object only (no markdown, no commentary) that matches this JSON Schema:`,
    JSON.stringify(jsonSchema),
  ].join("\n");

  let lastError = "";
  let usage: ModelUsage = emptyUsage();
  const maxRepairCalls = input.maxRepairCalls ?? 1;
  let providerRequestId: string | undefined;

  for (let call = 0; call <= maxRepairCalls; call += 1) {
    const prompt =
      call === 0
        ? instruction
        : [
            instruction,
            "",
            "## PREVIOUS ATTEMPT FAILED VALIDATION",
            `Error: ${lastError}`,
            "Fix the JSON object and respond again with corrected JSON only.",
          ].join("\n");

    const result = await input.callModel(prompt, input.system);
    providerRequestId = result.providerRequestId ?? providerRequestId;
    usage = mergeUsageLocal(usage, result.usage);

    try {
      const parsed = parseJsonCandidate(result.text);
      const validated = input.schema.parse(parsed);
      return { value: validated, usage, providerRequestId };
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 800) : String(error);
    }
  }

  throw new AiError("invalid_request", `structured output failed validation: ${lastError}`, {
    providerRequestId,
  });
}

/** 三级解析：直接 JSON → 代码块 → 首尾大括号截取 */
export function parseJsonCandidate(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    /* continue to fallbacks */
  }

  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (codeBlock?.[1]) {
    try {
      return JSON.parse(codeBlock[1]);
    } catch {
      /* continue to fallbacks */
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new Error("no JSON object found in response");
}

function mergeUsageLocal(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    images: a.images + b.images,
    costUsd:
      a.costUsd === undefined && b.costUsd === undefined
        ? undefined
        : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}
