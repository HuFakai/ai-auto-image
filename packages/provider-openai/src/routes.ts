import type { ProviderRouteConfig } from "@aai/shared-schemas";
import type { CompatCapabilities } from "./provider";

export const DEFAULT_TIMEOUT_MS = 120_000;

/** 官方 OpenAI 路由预设 */
export function openaiRoute(overrides: Partial<ProviderRouteConfig> = {}): ProviderRouteConfig {
  return {
    id: "openai",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyRef: "OPENAI_API_KEY",
    textModel: "gpt-4.1-mini",
    imageModel: "gpt-image-2",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxAttempts: 3,
    concurrencyMax: 0,
    ...overrides,
  };
}

/** xAI/Grok 路由预设（OpenAI SDK + xAI Base URL） */
export function xaiRoute(overrides: Partial<ProviderRouteConfig> = {}): ProviderRouteConfig {
  return {
    id: "xai",
    kind: "xai",
    baseUrl: "https://api.x.ai/v1",
    apiKeyRef: "XAI_API_KEY",
    textModel: "grok-4.5",
    imageModel: "grok-imagine-image-2.0",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxAttempts: 3,
    concurrencyMax: 0,
    ...overrides,
  };
}

/** xAI 能力声明：图片默认返回临时 URL，必须立即转存（docs/01 §4） */
export const XAI_CAPABILITIES: CompatCapabilities = {
  image: {
    imageEditSingle: true,
    imageEditMulti: false,
    maskEdit: false,
    returns: ["url"],
    supportsSeed: true,
    persistentFiles: false,
  },
  text: {
    structuredOutput: true,
    imageInput: true,
  },
};

/**
 * 推理型兼容模型的默认策略：DeepSeek 结构化输出若把 max_tokens 全耗在 reasoning 上，
 * 可能没有 final content。可通过 TEXT_DISABLE_REASONING=0 保留推理，=1 对兼容文本渠道统一关闭。
 */
export function shouldDisableReasoning(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = env.TEXT_DISABLE_REASONING?.trim().toLowerCase();
  if (configured === "1" || configured === "true") return true;
  if (configured === "0" || configured === "false") return false;
  return /deepseek/i.test(model);
}

/** 自定义 compatible 路由预设：全部能力显式配置，不根据模型名猜测 */
export function compatibleRoute(
  input: Partial<ProviderRouteConfig> = {},
): ProviderRouteConfig {
  if (!input.baseUrl) throw new Error("compatibleRoute requires baseUrl");
  return {
    id: "compatible",
    kind: "openai-compatible",
    baseUrl: input.baseUrl,
    apiKeyRef: "COMPATIBLE_API_KEY",
    textModel: input.textModel ?? "COMPATIBLE_TEXT_MODEL",
    imageModel: input.imageModel ?? "COMPATIBLE_IMAGE_MODEL",
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxAttempts: input.maxAttempts ?? 2,
    headers: input.headers,
    concurrencyMax: input.concurrencyMax ?? 0,
  };
}
