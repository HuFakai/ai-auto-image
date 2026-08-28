/**
 * Domain-level model interfaces. Business code depends only on these; SDK
 * types must never leak into workflow / recipe code.
 */
import type { z } from "zod";
import type { AspectRatio } from "@aai/shared-schemas";

export interface TextRequest {
  prompt: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** Provider/model may stream; caller chooses. */
  signal?: AbortSignal;
}

export interface TextResult {
  text: string;
  reasoning?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  model: string;
  finishReason?: string;
}

export interface ObjectRequest<T> extends TextRequest {
  /** Accepts schemas whose input type differs from output (defaults, coercion). */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  schemaDescription: string;
  /** One repair call with validation errors is allowed before giving up. */
}

export interface TextModel {
  generateText(request: TextRequest): Promise<TextResult>;
  generateObject<T>(request: ObjectRequest<T>): Promise<T>;
  streamText(request: TextRequest): AsyncIterable<string>;
}

export interface ImageCapabilities {
  textToImage: boolean;
  singleReferenceEdit: boolean;
  multiReferenceEdit: boolean;
  maskEdit: boolean;
  aspectRatios: AspectRatio[];
  maxImagesPerRequest: number;
  returnTypes: Array<"url" | "b64_json">;
  /** Returned URLs are temporary and must be persisted immediately. */
  temporaryUrls: boolean;
  supportsSeed: boolean;
  supportsTransparentBackground: boolean;
}

export interface ImageGenerateRequest {
  prompt: string;
  n?: number;
  aspectRatio?: AspectRatio;
  resolution?: "1k" | "2k";
  quality?: "low" | "medium";
  responseFormat?: "url" | "b64_json";
  signal?: AbortSignal;
}

export interface ImageReference {
  /** URL or data URL of the source image. */
  url: string;
}

export interface ImageEditRequest extends ImageGenerateRequest {
  references: ImageReference[];
  mask?: ImageReference;
}

export interface GeneratedImage {
  /** Remote URL if the provider returned one; always persist locally right away. */
  url?: string;
  b64?: string;
  mimeType?: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  model: string;
  usage: {
    imageCount: number;
  };
}

export interface ImageModel {
  generate(request: ImageGenerateRequest): Promise<ImageResult>;
  edit(request: ImageEditRequest): Promise<ImageResult>;
  capabilities(): ImageCapabilities;
}
