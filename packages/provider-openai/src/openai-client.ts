import OpenAI from "openai";
import type { ProviderRouteConfig } from "@aai/shared-schemas";
import type { WireClient } from "./provider";

/**
 * 用官方 openai SDK 构造 wire 客户端。
 * 重试完全由 ai-core 的路由层负责，因此 maxRetries: 0。
 * User-Agent 必须覆盖 SDK 默认值：部分兼容网关的 WAF 会 403 拦截 "OpenAI/JS" UA。
 */
export function createWireClient(config: ProviderRouteConfig, apiKey: string): WireClient {
  const client = new OpenAI({
    apiKey,
    baseURL: config.baseUrl,
    timeout: config.timeoutMs,
    maxRetries: 0,
    defaultHeaders: {
      "User-Agent": "ai-auto-image/0.1",
      ...config.headers,
    },
  });
  return client as unknown as WireClient;
}

/** 从环境变量解析路由密钥；密钥永远不进入日志 */
export function resolveApiKey(config: ProviderRouteConfig, env: NodeJS.ProcessEnv = process.env): string {
  const key = env[config.apiKeyRef];
  if (!key) {
    throw new Error(`missing API key: set ${config.apiKeyRef} in environment`);
  }
  return key;
}
