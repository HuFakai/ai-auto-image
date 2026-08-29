/** Token 求和工具复用 shared-schemas 的定义；usageFromOpenAI 在本文件定义 */
export { emptyUsage, mergeUsage } from "@aai/shared-schemas";

import type { ModelUsage } from "@aai/shared-schemas";

/** OpenAI SDK usage 字段 → 统一 ModelUsage */
export function usageFromOpenAI(
  usage:
    | {
        prompt_tokens?: number | null;
        completion_tokens?: number | null;
        total_tokens?: number | null;
      }
    | null
    | undefined,
): ModelUsage {
  if (!usage) return { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0 };
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    images: 0,
  };
}
