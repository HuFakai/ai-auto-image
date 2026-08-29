import type { ProviderBundle } from "@aai/ai-core";
import type { ProviderRouteConfig } from "@aai/shared-schemas";
import {
  XAI_CAPABILITIES,
  createOpenAICompatProvider,
  createWireClient,
  xaiRoute,
} from "@aai/provider-openai";

export interface CreateXaiProviderInput {
  config?: Partial<ProviderRouteConfig>;
  apiKey: string;
}

/**
 * xAI/Grok Provider：OpenAI SDK + https://api.x.ai/v1。
 * 注意：grok-imagine 返回的图片 URL 是临时地址，调用方必须立即转存自己的存储。
 */
export function createXaiProvider(input: CreateXaiProviderInput): ProviderBundle {
  const config: ProviderRouteConfig = xaiRoute(input.config);
  return createOpenAICompatProvider({
    config,
    apiKey: input.apiKey,
    client: createWireClient(config, input.apiKey),
    capabilities: XAI_CAPABILITIES,
  });
}

export { xaiRoute, XAI_CAPABILITIES };
