import { z } from "zod";

/** Provider 类型 */
export const ProviderKindSchema = z.enum(["openai", "xai", "openai-compatible", "mock"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

/** 统一 Provider 错误分类（docs/02 §8） */
export const ProviderErrorCategorySchema = z.enum([
  "authentication",
  "rate_limit",
  "content_policy",
  "invalid_request",
  "timeout",
  "provider_unavailable",
  "download_failed",
  "unknown",
]);
export type ProviderErrorCategory = z.infer<typeof ProviderErrorCategorySchema>;

/** 瞬态状态码：可重试（借鉴 grok_client TRANSIENT_STATUS_CODES） */
export const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Provider 路由配置。apiKeyRef 是密钥的环境变量名或引用，真实密钥不落库、不进日志。
 */
export const ProviderRouteConfigSchema = z.object({
  id: z.string().min(1),
  kind: ProviderKindSchema,
  baseUrl: z.string().min(1),
  apiKeyRef: z.string().min(1),
  textModel: z.string().optional(),
  imageModel: z.string().optional(),
  timeoutMs: z.number().int().positive().default(120_000),
  maxAttempts: z.number().int().min(1).default(3),
  headers: z.record(z.string(), z.string()).optional(),
  /** 该路由图片调用并发上限（能力表），参与 effective 并发计算 */
  imageConcurrencyMax: z.number().int().min(1).optional(),
});
export type ProviderRouteConfig = z.infer<typeof ProviderRouteConfigSchema>;

/** 模型用量：Token、图片数与实际成本（成本账本的数据源） */
export const ModelUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  images: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().optional(),
});
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export function emptyUsage(): ModelUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, images: 0 };
}

export function mergeUsage(a: ModelUsage | undefined, b: ModelUsage | undefined): ModelUsage {
  const x = a ?? emptyUsage();
  const y = b ?? emptyUsage();
  return {
    promptTokens: x.promptTokens + y.promptTokens,
    completionTokens: x.completionTokens + y.completionTokens,
    totalTokens: x.totalTokens + y.totalTokens,
    images: x.images + y.images,
    costUsd:
      x.costUsd === undefined && y.costUsd === undefined ? undefined : (x.costUsd ?? 0) + (y.costUsd ?? 0),
  };
}

/** Provider 归一化后的图片结果 */
export const GeneratedImageSchema = z.object({
  assetId: z.string().optional(),
  source: z.enum(["url", "base64", "file_id"]),
  remoteUrl: z.string().optional(),
  base64: z.string().optional(),
  providerFileId: z.string().optional(),
  mimeType: z.string().default("image/png"),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  providerRequestId: z.string().optional(),
  usage: ModelUsageSchema.optional(),
});
export type GeneratedImage = z.infer<typeof GeneratedImageSchema>;

/** 图片能力表：Provider 显式声明，不根据模型名猜测 */
export const ImageCapabilitiesSchema = z.object({
  textToImage: z.boolean(),
  imageEditSingle: z.boolean(),
  imageEditMulti: z.boolean(),
  maskEdit: z.boolean(),
  aspectRatios: z.array(z.string()),
  maxImagesPerRequest: z.number().int().min(1),
  returns: z.array(z.enum(["url", "base64", "file_id"])),
  supportsSeed: z.boolean(),
  supportsTransparentBackground: z.boolean(),
  persistentFiles: z.boolean(),
});
export type ImageCapabilities = z.infer<typeof ImageCapabilitiesSchema>;

/** 文本能力表 */
export const TextCapabilitiesSchema = z.object({
  structuredOutput: z.boolean(),
  imageInput: z.boolean(),
  maxOutputTokens: z.number().int().positive().optional(),
});
export type TextCapabilities = z.infer<typeof TextCapabilitiesSchema>;
