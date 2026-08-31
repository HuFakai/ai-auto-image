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
export interface WireRequestOptions {
  signal?: AbortSignal | undefined;
}

export interface WireClient {
  chat: {
    completions: {
      /** 参数透传（含 stream/stream_options）；返回整体响应或 chunk 异步流 */
      create(params: Record<string, unknown>, options?: WireRequestOptions): Promise<unknown>;
    };
  };
  images: {
    generate(params: Record<string, unknown>, options?: WireRequestOptions): Promise<unknown>;
    edit?(params: Record<string, unknown>, options?: WireRequestOptions): Promise<unknown>;
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
  /** 文本请求参数差异（例如 DeepSeek 兼容网关的推理开关） */
  textRequest?: {
    /** 通过 OpenAI-compatible 顶层 thinking 参数关闭 provider reasoning */
    disableReasoning?: boolean;
    /** 透传网关支持的额外 chat/completions 参数 */
    extraParams?: Record<string, unknown>;
  };
  image?: Partial<ImageCapabilities>;
  /** 比例 → 尺寸字符串映射（Provider 差异在此收敛） */
  aspectSizeMap?: AspectSizeMap;
  imageRequest?: ImageRequestOptions;
}

const DEFAULT_ASPECT_SIZE_MAP: Required<AspectSizeMap> = {
  "3:4": "768x1024",
  "9:16": "768x1360",
  "1:1": "1024x1024",
  "16:9": "1360x768",
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
  choices?: Array<ChatChoiceShape>;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
  } | null;
}

interface ChatChoiceShape {
  finish_reason?: string | null;
  text?: unknown;
  message?: {
    content?: unknown;
    reasoning_content?: unknown;
  };
  delta?: {
    content?: unknown;
    reasoning_content?: unknown;
  };
}

class EmptyChatResponseError extends AiError {
  constructor(
    readonly finishReason: string | undefined,
    readonly reasoningChars: number,
    readonly streaming: boolean,
  ) {
    super(
      "provider_unavailable",
      `empty response from text model${streaming ? " (stream)" : ""}; ` +
        `finish_reason=${finishReason ?? "unknown"}; reasoning_chars=${reasoningChars}`,
    );
    this.name = "EmptyChatResponseError";
  }
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const candidate = part as { text?: unknown; value?: unknown };
      if (typeof candidate.text === "string") return candidate.text;
      if (candidate.text && typeof candidate.text === "object") {
        const nested = candidate.text as { value?: unknown };
        if (typeof nested.value === "string") return nested.value;
      }
      return typeof candidate.value === "string" ? candidate.value : "";
    })
    .join("");
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
  const textRequestOptions = input.capabilities?.textRequest;
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
    const choice = body.choices?.[0];
    const text = extractText(choice?.message?.content ?? choice?.text);
    if (!text.trim()) {
      throw new EmptyChatResponseError(
        choice?.finish_reason ?? undefined,
        extractText(choice?.message?.reasoning_content).length,
        false,
      );
    }
    return {
      text,
      usage: usageFromOpenAI(body.usage),
      providerRequestId: body.id,
    };
  };

  /**
   * 流式调用 chat/completions：网关对长推理请求会在 ~2 分钟主动断连，
   * 流式的持续数据流动可避免断连；同时聚合 reasoning 后的 content 与 usage。
   * 返回值不可迭代时（测试 fake / 非 stream 实现）退回整体响应解析。
   */
  const readChatStream = async (response: unknown): Promise<TextResult> => {
    const iterable = response as AsyncIterable<unknown> | undefined;
    if (!iterable || typeof (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
      return readChatResponse(response);
    }
    let text = "";
    let providerRequestId: string | undefined;
    let usage: ModelUsage | undefined;
    let finishReason: string | undefined;
    let reasoningChars = 0;
    for await (const raw of iterable) {
      const chunk = raw as {
        id?: string;
        choices?: Array<ChatChoiceShape>;
        usage?: Parameters<typeof usageFromOpenAI>[0];
      };
      const choice = chunk.choices?.[0];
      const deltaText = extractText(choice?.delta?.content ?? choice?.text ?? choice?.message?.content);
      if (deltaText) text += deltaText;
      reasoningChars += extractText(choice?.delta?.reasoning_content ?? choice?.message?.reasoning_content).length;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.id) providerRequestId = chunk.id;
      if (chunk.usage) usage = usageFromOpenAI(chunk.usage);
    }
    if (!text.trim()) {
      throw new EmptyChatResponseError(finishReason, reasoningChars, true);
    }
    return { text, usage: usage ?? usageFromOpenAI(undefined), providerRequestId };
  };

  const chatCall = async (
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<TextResult> => {
    const baseBody: Record<string, unknown> = {
      ...(textRequestOptions?.extraParams ?? {}),
      ...body,
    };
    if (textRequestOptions?.disableReasoning) {
      // 部分兼容网关接受顶层 thinking；直接把 extra_body 作为 JSON 字段发送会返回 400。
      baseBody.thinking = { type: "disabled" };
    }

    const response = await client.chat.completions.create(
      { ...baseBody, stream: true, stream_options: { include_usage: true } },
      options,
    );
    try {
      return await readChatStream(response);
    } catch (error) {
      // 推理网关可能把 max_tokens 全部消耗在 reasoning_content，导致没有 final content。
      // 按 Auto-AI-Video 的兼容策略补一次更大预算的非流式请求；reasoning 已显式关闭时不重复收费。
      if (!(error instanceof EmptyChatResponseError) || textRequestOptions?.disableReasoning) throw error;
      const currentBudget = typeof baseBody.max_tokens === "number" ? baseBody.max_tokens : 0;
      const retryBudget = Math.min(Math.max(currentBudget * 2, 4096), 16_000);
      if (retryBudget <= currentBudget) throw error;
      const retryBody: Record<string, unknown> = { ...baseBody, max_tokens: retryBudget, stream: false };
      delete retryBody.stream_options;
      const retryResponse = await client.chat.completions.create(retryBody, options);
      return readChatResponse(retryResponse);
    }
  };

  const textModel: TextModel = {
    routeId: config.id,
    model: textModelName,
    capabilities: () => textCaps,

    async generateText(request) {
      const messages: WireChatMessage[] = [];
      if (request.system) messages.push({ role: "system", content: request.system });
      messages.push({ role: "user", content: request.prompt });
      return chatCall(
        {
          model: textModelName,
          messages,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature,
        },
        { signal: request.signal },
      );
    },

    async generateObject<T>(request: StructuredRequest<T>): Promise<T> {
      const result = await generateStructured({
        schemaName: request.schemaName,
        schema: request.schema,
        system: request.system,
        prompt: request.prompt,
        signal: request.signal,
        callModel: async (prompt, system, signal) => {
          const messages: WireChatMessage[] = [];
          if (system) messages.push({ role: "system", content: system });
          messages.push({ role: "user", content: prompt });
          return chatCall(
            {
              model: textModelName,
              messages,
              // 推理类模型（如 deepseek-v4-flash）会消耗 reasoning token，
              // 结构化 JSON 输出必须给足输出预算，避免 finish_reason=length 的空响应
              max_tokens: request.maxOutputTokens ?? 8192,
              temperature: request.temperature ?? 0.2,
            },
            { signal },
          );
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

      const response = await client.images.generate(params, { signal: request.signal });
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
      const imageData = request.baseImage.base64 ?? "";
      if (!imageData) {
        throw new AiError("invalid_request", "image edit requires base64 reference image");
      }
      // gpt-image 系网关（doc.yunfei.best）：/v1/images/edits 为 multipart 文件上传，
      // image 为文件字段（可多图），size 不传则沿用参考图尺寸；不支持 JSON {url} 传法
      const { toFile } = await import("openai");
      const imageFile = await toFile(Buffer.from(imageData.replace(/^data:[^,]+,/, ""), "base64"), "reference.png", {
        type: "image/png",
      });
      const params: Record<string, unknown> = {
        model: imageModelName,
        prompt: request.prompt,
        n: request.n ?? 1,
        image: imageFile,
      };
      if (request.maskBase64) {
        params.mask = await toFile(Buffer.from(request.maskBase64.replace(/^data:[^,]+,/, ""), "base64"), "mask.png", {
          type: "image/png",
        });
      }

      const response = await client.images.edit(params, { signal: request.signal });
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
          return chatCall(
            {
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
            },
          );
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
