import type { ProviderBundle } from "@aai/ai-core";
import type { ProviderRouteConfig } from "@aai/shared-schemas";
import {
  compatibleRoute,
  createOpenAICompatProvider,
  createWireClient,
  type CompatCapabilities,
} from "@aai/provider-openai";

export interface CreateCompatibleProviderInput {
  /** 自定义 Base URL 与可选 Header（提供方差异通过此配置收敛） */
  config: Partial<ProviderRouteConfig> & { baseUrl: string };
  apiKey: string;
  /**
   * 能力必须显式配置，不根据模型名猜测（docs/phases/00 §5.4）。
   * 未声明的编辑/掩码/Seed 等能力一律视为不支持。
   */
  capabilities: CompatCapabilities;
}

/** 自定义 OpenAI-compatible Provider */
export function createCompatibleProvider(input: CreateCompatibleProviderInput): ProviderBundle {
  const config: ProviderRouteConfig = compatibleRoute(input.config);
  return createOpenAICompatProvider({
    config,
    apiKey: input.apiKey,
    client: createWireClient(config, input.apiKey),
    capabilities: input.capabilities,
  });
}

export { compatibleRoute };
