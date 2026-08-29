import {
  AiError,
  emptyUsage,
  generateStructured,
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
  ContentBriefSchema,
  StoryboardSchema,
  type ContentBrief,
  type ImageCapabilities,
  type ModelUsage,
  type Storyboard,
  type TextCapabilities,
} from "@aai/shared-schemas";
import { renderPlaceholderImage } from "./placeholder";

export interface MockProviderOptions {
  /** 每次模型调用的模拟延迟 */
  latencyMs?: number;
  /** generateText 的顺序脚本（循环末项） */
  textScript?: string[];
  /** 返回 true 时该次图片调用抛错（用于单页重试测试） */
  shouldFailImage?: (request: ImageGenerateRequest) => boolean;
  /** 返回 true 时该次文本调用抛错 */
  shouldFailText?: (prompt: string) => boolean;
  /** 覆盖视觉检查结果 */
  visualInspection?: VisualInspectionResult;
  /** 覆盖图片生成（默认渲染占位图卡） */
  imageRenderer?: (request: ImageGenerateRequest) => Promise<Buffer>;
}

export interface MockControls {
  setBrief(brief: ContentBrief): void;
  setStoryboard(storyboard: Storyboard): void;
  calls: { text: number; object: number; image: number; inspect: number };
}

export interface MockProvider {
  bundle: ProviderBundle;
  controls: MockControls;
}

const MOCK_ROUTE = {
  id: "mock",
  kind: "mock" as const,
  baseUrl: "mock://local",
  apiKeyRef: "MOCK_API_KEY",
  textModel: "mock-text",
  imageModel: "mock-image",
  timeoutMs: 30_000,
  maxAttempts: 1,
  imageConcurrencyMax: 4,
};

/** 可被 AbortSignal 中断的延迟：取消语义在 Mock 中与真实 HTTP 调用一致 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 && !signal) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 从 Prompt 里提取主题/比例/平台/标题（节点按约定格式拼 Prompt） */
export function extractContext(prompt: string): {
  topic: string;
  aspectRatio: string | undefined;
  platform: string | undefined;
  headline: string | undefined;
} {
  const lines = prompt.split("\n");
  const pick = (pattern: RegExp): string | undefined => {
    for (const line of lines) {
      const match = line.match(pattern);
      if (match?.[1]) return match[1].trim();
    }
    return undefined;
  };
  const ratio = pick(/画布比例[:：]\s*(3:4|9:16|1:1|16:9)/);
  const platform = pick(/目标平台[:：]\s*(xiaohongshu|douyin|wechat)/);
  return {
    topic: pick(/主题[:：]\s*(.+)/) ?? "Mock 主题",
    aspectRatio: ratio,
    platform,
    headline: pick(/标题[:：]\s*(.+)/),
  };
}

function defaultBrief(topic: string): ContentBrief {
  return ContentBriefSchema.parse({
    topic,
    audience: "对主题感兴趣的大众读者",
    objective: "educate",
    coreMessage: `关于「${topic}」最值得记住的一个判断`,
    evidence: [
      { claim: `${topic}的核心事实由用户输入提供`, confidence: "provided" },
      { claim: "示例引用用于演示可追溯性", source: "mock", confidence: "inferred" },
    ],
    tone: ["清晰", "克制", "口语化"],
    callToAction: "收藏这份图卡，需要时翻出来看",
    prohibitedClaims: ["绝对", "百分百", "包治", "稳赚"],
  });
}

function defaultStoryboard(topic: string, aspectRatio: string, platform: string): Storyboard {
  return StoryboardSchema.parse({
    title: `${topic}：一图读懂`,
    platform: platform === "douyin" || platform === "wechat" ? platform : "xiaohongshu",
    aspectRatio: aspectRatio === "9:16" || aspectRatio === "1:1" || aspectRatio === "16:9" ? aspectRatio : "3:4",
    slides: [
      {
        index: 0,
        role: "cover",
        headline: `${topic}`,
        body: ["一图读懂系列"],
        visualIntent: "深色底大标题，琥珀色点缀",
        layoutHint: "居中大字",
      },
      {
        index: 1,
        role: "content",
        headline: "它到底是什么",
        body: [`${topic}的一句话解释`, "把复杂概念翻译成人话"],
        visualIntent: "简洁示意插画",
        layoutHint: "上图下文",
      },
      {
        index: 2,
        role: "content",
        headline: "为什么重要",
        body: ["和日常场景建立联系", "给出一个可记忆的类比"],
        visualIntent: "场景插画",
        layoutHint: "左文右图",
      },
      {
        index: 3,
        role: "summary",
        headline: "记住这一句",
        body: [`关于${topic}，先记住核心判断`],
        visualIntent: "收尾总结版式",
        layoutHint: "居中",
      },
    ],
  });
}

/** 构造 Mock Provider：开发和 CI 的确定性基础，也用于演示占位图卡 */
export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const controls: MockControls = {
    calls: { text: 0, object: 0, image: 0, inspect: 0 },
    setBrief(brief) {
      currentBrief = ContentBriefSchema.parse(brief);
    },
    setStoryboard(storyboard) {
      currentStoryboard = StoryboardSchema.parse(storyboard);
    },
  };
  let currentBrief: ContentBrief | null = null;
  let currentStoryboard: Storyboard | null = null;
  let scriptIndex = 0;

  const textCaps: TextCapabilities = { structuredOutput: true, imageInput: true };
  const imageCaps: ImageCapabilities = {
    textToImage: true,
    imageEditSingle: true,
    imageEditMulti: true,
    maskEdit: false,
    aspectRatios: ["1:1", "3:4", "9:16", "16:9"],
    maxImagesPerRequest: 4,
    returns: ["base64"],
    supportsSeed: true,
    supportsTransparentBackground: true,
    persistentFiles: true,
  };

  const textModel: TextModel = {
    routeId: MOCK_ROUTE.id,
    model: MOCK_ROUTE.textModel!,
    capabilities: () => textCaps,

    async generateText(request): Promise<TextResult> {
      await delay(options.latencyMs ?? 0, request.signal);
      controls.calls.text += 1;
      if (options.shouldFailText?.(request.prompt)) {
        throw new AiError("provider_unavailable", "mock text failure");
      }
      if (options.textScript?.length) {
        const text = options.textScript[Math.min(scriptIndex, options.textScript.length - 1)]!;
        scriptIndex += 1;
        return { text, usage: emptyUsage() };
      }
      return { text: `（Mock 回复）${request.prompt.slice(0, 80)}`, usage: emptyUsage() };
    },

    async generateObject<T>(request: StructuredRequest<T>): Promise<T> {
      await delay(options.latencyMs ?? 0, request.signal);
      controls.calls.object += 1;
      if (options.shouldFailText?.(request.prompt)) {
        throw new AiError("provider_unavailable", "mock object failure");
      }
      const context = extractContext(request.prompt);
      const mockUsage: ModelUsage = { promptTokens: 10, completionTokens: 30, totalTokens: 40, images: 0 };
      if (request.schemaName === "ContentBrief") {
        request.onUsage?.(mockUsage);
        return (currentBrief ?? defaultBrief(context.topic)) as unknown as T;
      }
      if (request.schemaName === "Storyboard") {
        request.onUsage?.(mockUsage);
        return (currentStoryboard ??
          defaultStoryboard(
            context.topic,
            context.aspectRatio ?? "3:4",
            context.platform ?? "xiaohongshu",
          )) as unknown as T;
      }
      // 未知 Schema：走共享结构化管道，把请求转成 JSON 校验失败 → 可诊断错误
      return generateStructured({
        schemaName: request.schemaName,
        schema: request.schema,
        prompt: request.prompt,
        callModel: async () => ({
          text: JSON.stringify({ note: "mock has no handler", schemaName: request.schemaName }),
          usage: emptyUsage(),
        }),
      }).then((r) => r.value);
    },
  };

  const imageModel: ImageModel = {
    routeId: MOCK_ROUTE.id,
    model: MOCK_ROUTE.imageModel!,
    capabilities: () => imageCaps,

    async generate(request: ImageGenerateRequest) {
      await delay(options.latencyMs ?? 0, request.signal);
      controls.calls.image += 1;
      if (options.shouldFailImage?.(request)) {
        throw new AiError("content_policy", "mock image failure");
      }
      const context = extractContext(request.prompt);
      const pageCountMatch = request.prompt.match(/页码[:：]\s*(\d+)\s*\/\s*(\d+)/);
      const pageIndex = pageCountMatch ? Number(pageCountMatch[1]) - 1 : 0;
      const pageCount = pageCountMatch ? Number(pageCountMatch[2]) : 4;
      const buffer =
        (await options.imageRenderer?.(request)) ??
        (await renderPlaceholderImage({
          aspectRatio: (context.aspectRatio as never) ?? request.aspectRatio,
          title: context.headline ?? context.topic,
          subtitle: context.topic,
          pageIndex,
          pageCount,
        }));
      const usage: ModelUsage = { ...emptyUsage(), images: 1, totalTokens: 0 };
      return [
        {
          source: "base64",
          base64: buffer.toString("base64"),
          mimeType: "image/png",
          providerRequestId: `mock_img_${controls.calls.image}`,
          usage,
        },
      ];
    },

    async edit(request: ImageEditRequest) {
      return imageModel.generate({
        prompt: request.prompt,
        aspectRatio: request.aspectRatio,
        n: request.n,
      });
    },
  };

  const visualQualityModel: VisualQualityModel = {
    routeId: MOCK_ROUTE.id,
    model: "mock-visual",
    async inspect(_request: VisualInspectionRequest): Promise<VisualInspectionResult> {
      await delay(options.latencyMs ?? 0);
      controls.calls.inspect += 1;
      if (options.visualInspection) return options.visualInspection;
      return {
        passed: true,
        checks: [{ name: "mock_visual_check", status: "pass", detail: "mock 通过" }],
      };
    },
  };

  return {
    bundle: {
      config: { ...MOCK_ROUTE, maxAttempts: MOCK_ROUTE.maxAttempts },
      text: textModel,
      image: imageModel,
      visualQuality: visualQualityModel,
    },
    controls,
  };
}
