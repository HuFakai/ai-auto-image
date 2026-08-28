import {
  AiError,
  errorFromStatus,
  type ImageCapabilities,
  type ImageEditRequest,
  type ImageGenerateRequest,
  type ImageModel,
  type ImageResult,
} from "@aai/ai-core";
import type { AspectRatio } from "@aai/shared-schemas";

/**
 * xAI / Grok image provider (grok2api gateway, OpenAI-style JSON protocol).
 * - generations: POST /v1/images/generations
 * - edits:       POST /v1/images/edits   (image/images must be objects: {"url": ...})
 * Returned URLs are temporary gateway links and MUST be persisted immediately.
 */
export interface XaiImageConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  editModel?: string;
}

interface ImageApiResponse {
  created?: number;
  data?: Array<{ url?: string; b64_json?: string; mime_type?: string; revised_prompt?: string }>;
  error?: { message?: string; code?: string };
}

const SUPPORTED_RATIOS: AspectRatio[] = ["3:4", "9:16", "1:1", "16:9", "4:3"];

export class XaiImageProvider implements ImageModel {
  constructor(private readonly cfg: XaiImageConfig) {}

  capabilities(): ImageCapabilities {
    return {
      textToImage: true,
      singleReferenceEdit: true,
      multiReferenceEdit: true,
      maskEdit: false,
      aspectRatios: SUPPORTED_RATIOS,
      maxImagesPerRequest: 10,
      returnTypes: ["url", "b64_json"],
      temporaryUrls: true,
      supportsSeed: false,
      supportsTransparentBackground: false,
    };
  }

  async generate(request: ImageGenerateRequest): Promise<ImageResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      prompt: request.prompt,
      n: request.n ?? 1,
      response_format: request.responseFormat ?? "url",
    };
    if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
    if (request.resolution) body.resolution = request.resolution;
    if (request.quality) body.quality = request.quality;
    return this.call("/images/generations", body, request.signal);
  }

  async edit(request: ImageEditRequest): Promise<ImageResult> {
    if (request.references.length === 0) {
      throw new AiError("invalid_input", "image edit requires at least one reference image");
    }
    const images = request.references.map((r) => ({ url: r.url }));
    const body: Record<string, unknown> = {
      model: this.cfg.editModel ?? this.cfg.model,
      prompt: request.prompt,
      images,
      n: request.n ?? 1,
      quality: request.quality ?? "medium",
      response_format: request.responseFormat ?? "url",
    };
    if (request.aspectRatio) body.aspect_ratio = request.aspectRatio;
    return this.call("/images/edits", body, request.signal);
  }

  private async call(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ImageResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw errorFromStatus(res.status, await res.text().catch(() => ""));
      }
      const json = (await res.json()) as ImageApiResponse;
      if (json.error) {
        throw new AiError("upstream", `provider returned error: ${json.error.message ?? json.error.code}`);
      }
      const images = (json.data ?? [])
        .map((d) => ({ url: d.url, b64: d.b64_json, mimeType: d.mime_type }))
        .filter((d) => d.url || d.b64);
      if (images.length === 0) {
        throw new AiError("upstream", "provider returned no images");
      }
      return {
        images,
        model: body.model as string,
        usage: { imageCount: images.length },
      };
    } catch (err) {
      if (err instanceof AiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new AiError("timeout", `image generation timed out: ${path}`);
      }
      throw new AiError("upstream", `image request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
