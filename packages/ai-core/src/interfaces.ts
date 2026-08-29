import type {
  AspectRatio,
  GeneratedImage,
  ImageCapabilities,
  ModelUsage,
  ProviderRouteConfig,
  TextCapabilities,
} from "@aai/shared-schemas";
import type { z } from "zod";

/* ── Text model ───────────────────────────────────────────────── */

export interface TextRequest {
  system?: string | undefined;
  prompt: string;
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
}

export interface TextResult {
  text: string;
  usage: ModelUsage;
  providerRequestId?: string | undefined;
}

export interface StructuredRequest<T> {
  system?: string | undefined;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
  /** 接收本次调用的 Token 用量（generateObject 只返回值，用量经此上报成本账本） */
  onUsage?: ((usage: ModelUsage) => void) | undefined;
}

/** 业务层统一的文本模型接口：不暴露 SDK 类型 */
export interface TextModel {
  readonly routeId: string;
  readonly model: string;
  generateText(request: TextRequest): Promise<TextResult>;
  generateObject<T>(request: StructuredRequest<T>): Promise<T>;
  capabilities(): TextCapabilities;
}

/* ── Image model ──────────────────────────────────────────────── */

export interface ReferenceImage {
  base64?: string | undefined;
  url?: string | undefined;
}

export interface ImageGenerateRequest {
  prompt: string;
  aspectRatio: AspectRatio;
  n?: number | undefined;
  quality?: "standard" | "high" | undefined;
  seed?: number | undefined;
  referenceImages?: ReferenceImage[] | undefined;
  signal?: AbortSignal | undefined;
}

export interface ImageEditRequest extends ImageGenerateRequest {
  /** 待编辑的源图 */
  baseImage: ReferenceImage;
  maskBase64?: string | undefined;
}

/** 业务层统一的图片模型接口 */
export interface ImageModel {
  readonly routeId: string;
  readonly model: string;
  generate(request: ImageGenerateRequest): Promise<GeneratedImage[]>;
  edit?(request: ImageEditRequest): Promise<GeneratedImage[]>;
  capabilities(): ImageCapabilities;
}

/* ── Visual quality model ─────────────────────────────────────── */

export interface VisualInspectionRequest {
  imageBase64?: string | undefined;
  imageUrl?: string | undefined;
  instruction: string;
  /** 原生模式：期望出现在图上的文字，逐字比对 */
  expectedText?: string[] | undefined;
}

export interface VisualInspectionResult {
  passed: boolean;
  checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }>;
  rawText?: string | undefined;
  usage?: ModelUsage | undefined;
}

export interface VisualQualityModel {
  readonly routeId: string;
  readonly model: string;
  inspect(request: VisualInspectionRequest): Promise<VisualInspectionResult>;
}

/* ── Route binding ────────────────────────────────────────────── */

/** 一个已绑定路由与模型的 Provider 实例集合 */
export interface ProviderBundle {
  config: ProviderRouteConfig;
  text: TextModel | null;
  image: ImageModel | null;
  visualQuality: VisualQualityModel | null;
}
