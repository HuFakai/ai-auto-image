import {
  AiError,
  generateStructured,
  usageFromOpenAI,
  type ImageGenerateRequest,
  type ImageModel,
  type ImageEditRequest,
  type ProviderBundle,
  type StructuredRequest,
  type TextModel,
  type TextResult,
  type VisualInspectionRequest,
  type VisualInspectionResult,
  type VisualQualityModel,
} from "@aai/ai-core";
import {
  emptyUsage as schemaEmptyUsage,
  mergeUsage,
  type AspectRatio,
  type ImageCapabilities,
  type ModelUsage,
  type ProviderRouteConfig,
  type TextCapabilities,
} from "@aai/shared-schemas";
import { z } from "zod";
import { extractGeneratedImages } from "./image-extract";

/**
 * 通用 OpenAI-compatible Wire 层。
 * 结构化最小接口便于测试注入假客户端；官方 OpenAI、xAI 与自定义兼容服务共用本实现。
 */
export interface WireChatContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}
export interface WireChatMessage {
  role: "system" | "user" | "assistant";
  content: string | WireChatContentPart[];
}
export interface WireClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: WireChatMessage[];
        max_tokens?: number;
        temperature?: number;
      }): Promise<unknown>;
    };
  };
  images: {
    generate(params: Record<string, unknown>): Promise<unknown>;
    edit?(params: Record<string, unknown>): Promise<unknown>;
  };
}

export interface AspectSizeMap {
  "3:4"?: string;
  "9:16"?: string;
  "1:1"?: string;
  "16:9"?: string;
}

/** 图片请求参数的网关差异（grok2api 等兼容网关用 aspect_ratio 而非 size） */
export interface ImageRequestOptions {
  /** 比例参数风格：size（OpenAI 官方，默认）或 aspect_ratio（grok2api 等网关） */
  aspectRatioParam?: "size" | "aspect_ratio";
  /** 显式请求的返回格式；不传则由网关默认决定 */
  responseFormat?: "url" | "b64_json";
  /** 分辨率/质量类透传参数（如 grok2api 的 1k/2k） */
  extraParams?: Record<string, unknown>;
}

export interface CompatCapabilities {
  text?: Partial<TextCapabilities>;
  image?: Partial<ImageCapabilities>;
  /** 比例 → 尺寸字符串映射（Provider 差异在此收敛） */
  aspectSizeMap?: AspectSizeMap;
  imageRequest?: ImageRequestOptions;
}

const DEFAULT_ASPECT_SIZE_MAP: Required<AspectSizeMap> = {
  "3:4": "1024x1536",
  "9:16": "1024x1536",
  "1:1": "1024x1024",
  "16:9": "1536x1024",
};

const DEFAULT_IMAGE_CAPABILITIES: ImageCapabilities = {
  textToImage: true,
  imageEditSingle: true,
  imageEditMulti: false,
  maskEdit: false,
  aspectRatios: ["1:1", "3:4", "9:16", "16:9"],
  maxImagesPerRequest: 4,
  returns: ["url", "base64"],
  supportsSeed: false,
  supportsTransparentBackground: false,
  persistentFiles: false,
};

const DEFAULT_TEXT_CAPABILITIES: TextCapabilities = {
  structuredOutput: true,
  imageInput: true,
};

interface ChatResponseShape {
  id?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
  } | null;
}

export interface CreateCompatProviderInput {
  config: ProviderRouteConfig;
  apiKey: string;
  /** 注入已构造的 wire 客户端（测试用）；否则需要提供 clientFactory */
  client: WireClient;
  capabilities?: CompatCapabilities | undefined;
}

/** 构造一个通用 OpenAI-compatible Provider（openai / xai / compatible 共用） */
export function createOpenAICompatProvider(input: CreateCompatProviderInput): ProviderBundle {
  const { config, client } = input;
  const textCaps: TextCapabilities = { ...DEFAULT_TEXT_CAPABILITIES, ...input.capabilities?.text };
  const imageCaps: ImageCapabilities = { ...DEFAULT_IMAGE_CAPABILITIES, ...input.capabilities?.image };
  const aspectSizeMap: Required<AspectSizeMap> = {
    ...DEFAULT_ASPECT_SIZE_MAP,
    ...input.capabilities?.aspectSizeMap,
  };
  const textModelName = config.textModel ?? "gpt-4.1-mini";
  const imageModelName = config.imageModel ?? "gpt-image-1";

  const readChatResponse = (response: unknown): TextResult => {
    const body = response as ChatResponseShape;
    const text = body.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      throw new AiError("provider_unavailable", "empty response from text model");
    }
    return {
      text,
      usage: usageFromOpenAI(body.usage),
      providerRequestId: body.id,
    };
  };

  const textModel: TextModel = {
    routeId: config.id,
    model: textModelName,
    capabilities: () => textCaps,

    async generateText(request) {
      const messages: WireChatMessage[] = [];
      if (request.system) messages.push({ role: "system", content: request.system });
      messages.push({ role: "user", content: request.prompt });
      const response = await client.chat.completions.create({
        model: textModelName,
        messages,
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
      });
      return readChatResponse(response);
    },

    async generateObject<T>(request: StructuredRequest<T>): Promise<T> {
      const result = await generateStructured({
        schemaName: request.schemaName,
        schema: request.schema,
        system: request.system,
        prompt: request.prompt,
        callModel: async (prompt, system) => {
          const messages: WireChatMessage[] = [];
          if (system) messages.push({ role: "system", content: system });
          messages.push({ role: "user", content: prompt });
          const response = await client.chat.completions.create({
            model: textModelName,
            messages,
            // 推理类模型（如 deepseek-v4-flash）会消耗 reasoning token，
            // 结构化 JSON 输出必须给足输出预算，避免 finish_reason=length 的空响应
            max_tokens: request.maxOutputTokens ?? 8192,
            temperature: request.temperature ?? 0.2,
          });
          return readChatResponse(response);
        },
      });
      request.onUsage?.(result.usage);
      return result.value;
    },
  };

  const extractUsageFromImageResponse = (response: unknown): ModelUsage => {
    const usage = (response as { usage?: Parameters<typeof usageFromOpenAI>[0] }).usage;
    const base = usageFromOpenAI(usage);
    const imageCount = (response as { data?: unknown[] }).data?.length ?? 0;
    return { ...base, images: Math.max(base.images, imageCount) };
  };

  const imageModel: ImageModel = {
    routeId: config.id,
    model: imageModelName,
    capabilities: () => imageCaps,

    async generate(request: ImageGenerateRequest) {
      const imageRequest = input.capabilities?.imageRequest ?? {};
      const params: Record<string, unknown> = {
        model: imageModelName,
        prompt: request.prompt,
        n: request.n ?? 1,
      };
      if ((imageRequest.aspectRatioParam ?? "size") === "aspect_ratio") {
        params.aspect_ratio = request.aspectRatio;
      } else {
        params.size = aspectSizeMap[request.aspectRatio as AspectRatio] ?? "1024x1536";
      }
      if (imageRequest.responseFormat) params.response_format = imageRequest.responseFormat;
      if (imageRequest.extraParams) Object.assign(params, imageRequest.extraParams);
      if (request.quality) params.quality = request.quality;
      if (request.seed !== undefined && imageCaps.supportsSeed) params.seed = request.seed;

      const response = await client.images.generate(params);
      const images = extractGeneratedImages(response);
      if (images.length === 0) {
        throw new AiError("provider_unavailable", "image response contained no images");
      }
      const usage = extractUsageFromImageResponse(response);
      return images.map((image) => ({
        ...image,
        usage: mergeUsage(schemaEmptyUsage(), usage),
      }));
    },

    async edit(request: ImageEditRequest) {
      if (!client.images.edit) {
        throw new AiError("invalid_request", `route ${config.id} does not support image edit`);
      }
      const imageData = request.baseImage.base64 ?? request.baseImage.url ?? "";
      const params: Record<string, unknown> = {
        model: imageModelName,
        prompt: request.prompt,
        n: request.n ?? 1,
        // compatible 服务普遍接受 data URL 或裸 Base64；官方 SDK 场景由上层转 File
        image: imageData.startsWith("http")
          ? imageData
          : imageData.startsWith("data:")
            ? imageData
            : `data:image/png;base64,${imageData}`,
      };
      if (request.maskBase64) params.mask = `data:image/png;base64,${request.maskBase64}`;
      if (request.quality) params.quality = request.quality;

      const response = await client.images.edit(params);
      const images = extractGeneratedImages(response);
      if (images.length === 0) {
        throw new AiError("provider_unavailable", "image edit response contained no images");
      }
      const usage = extractUsageFromImageResponse(response);
      return images.map((image) => ({
        ...image,
        usage: mergeUsage(schemaEmptyUsage(), usage),
      }));
    },
  };

  const VisualInspectionSchema = z.object({
    passed: z.boolean(),
    checks: z.array(
      z.object({
        name: z.string(),
        status: z.enum(["pass", "warn", "fail"]),
        detail: z.string(),
      }),
    ),
  });

  const visualQualityModel: VisualQualityModel = {
    routeId: config.id,
    model: textModelName,
    async inspect(request: VisualInspectionRequest): Promise<VisualInspectionResult> {
      const imageUrl = request.imageBase64
        ? `data:image/png;base64,${request.imageBase64}`
        : request.imageUrl;
      if (!imageUrl) throw new AiError("invalid_request", "visual inspection requires an image");

      const expected = request.expectedText?.length
        ? `\n图片中应出现的文字（逐字精确比对，缺字/错字/多字都算 fail）：\n${request.expectedText
            .map((line) => `- ${JSON.stringify(line)}`)
            .join("\n")}`
        : "";
      const prompt = [
        request.instruction,
        expected,
        "",
        "以 JSON 返回检查结果。",
      ].join("\n");

      const result = await generateStructured({
        schemaName: "VisualInspection",
        schema: VisualInspectionSchema,
        prompt,
        callModel: async (fullPrompt) => {
          const response = await client.chat.completions.create({
            model: textModelName,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: fullPrompt },
                  { type: "image_url", image_url: { url: imageUrl } },
                ],
              },
            ],
            max_tokens: 1024,
            temperature: 0,
          });
          return readChatResponse(response);
        },
      });

      return {
        passed: result.value.passed,
        checks: result.value.checks,
        usage: result.usage,
      };
    },
  };

  return {
    config,
    text: textModel,
    image: imageModel,
    visualQuality: textCaps.imageInput ? visualQualityModel : null,
  };
}
