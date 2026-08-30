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

/** Mock 封面候选：三个候选各用一条知识类标题公式（数字型/悬念型/直给型） */
function defaultCoverCandidates(topic: string): Array<{
  hookTitle: string;
  visualPrompt: string;
  styleNote: string;
}> {
  const t = topic.slice(0, 8);
  return [
    {
      hookTitle: `3个方法看懂${t}`.slice(0, 20),
      visualPrompt: `${topic}封面主视觉：简洁示意插画，主体居中，留白充足`,
      styleNote: "构图公式：数字型 · 居中构图",
    },
    {
      hookTitle: `原来${t}一直被误解`.slice(0, 20),
      visualPrompt: `${topic}封面主视觉：悬念氛围，暖光从侧面打入，聚焦一个核心物件`,
      styleNote: "构图公式：悬念型 · 侧光特写",
    },
    {
      hookTitle: `一文讲透${t}`.slice(0, 20),
      visualPrompt: `${topic}封面主视觉：图表化排版元素，深浅两色对比，视觉重心在下方`,
      styleNote: "构图公式：直给型 · 图表化",
    },
  ];
}

function defaultStoryboard(topic: string, aspectRatio: string, platform: string): Storyboard {  return StoryboardSchema.parse({
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
      if (request.schemaName === "ComicCast") {
        request.onUsage?.(mockUsage);
        return [
          {
            name: "小知",
            appearance: "圆脸短发少年，戴一副圆框眼镜，额前一撮呆毛",
            outfit: "蓝色连帽衫、牛仔裤、白色运动鞋，胸前挂一枚铜色放大镜徽章",
            refImagePrompt: `${context.topic}科普向导小知的正面全身立绘，纯浅色背景，清晰勾线漫画风`,
            forbiddenChanges: ["发型", "眼镜", "连帽衫颜色", "放大镜徽章"],
          },
        ] as unknown as T;
      }
      if (request.schemaName === "ComicStoryboard") {
        request.onUsage?.(mockUsage);
        const base = context.topic;
        return {
          title: `${base}（科普漫画）`,
          cast: [
            {
              name: "小知",
              appearance: "圆脸短发少年，戴圆框眼镜，额前一撮呆毛",
              outfit: "蓝色连帽衫、牛仔裤，胸前放大镜徽章",
              refImagePrompt: "参考图",
              forbiddenChanges: ["发型", "眼镜"],
            },
          ],
          pages: [
            {
              index: 0,
              scene: "少年在书桌前翻开一本发光的书",
              visualPrompt: `${base}：小知在书桌前翻开一本发光的书，好奇地凑近`,
              cast: ["小知"],
              dialogues: [{ speaker: "小知", text: `关于${base}，你真的了解吗？`, type: "speech" }],
            },
            {
              index: 1,
              scene: "黑板前讲解核心概念",
              visualPrompt: `${base}：小知站在小黑板前，用指示棒讲解核心概念`,
              cast: ["小知"],
              dialogues: [
                { speaker: "小知", text: "先记住一个关键判断。", type: "speech" },
                { speaker: "旁白", text: "核心概念拆开看其实很简单。", type: "narration" },
              ],
            },
            {
              index: 2,
              scene: "生活场景举例",
              visualPrompt: `${base}：小知在日常生活场景中举例说明，配简单示意图`,
              cast: ["小知"],
              dialogues: [{ speaker: "小知", text: "生活里到处都是例子。", type: "speech" }],
            },
            {
              index: 3,
              scene: "总结收尾",
              visualPrompt: `${base}：小知竖起大拇指做总结，身后是知识点列表`,
              cast: ["小知"],
              dialogues: [{ speaker: "小知", text: "记住这句就够了！", type: "speech" }],
            },
          ],
        } as unknown as T;
      }
      if (request.schemaName === "PlatformCopy") {
        request.onUsage?.(mockUsage);
        return {
          title: context.topic.slice(0, 20),
          body: `关于「${context.topic}」的要点都在这套图里了，看完记得收藏。\n评论区聊聊你的想法。`,
          tags: ["#干货分享", "#知识科普", "#收藏备用", "#一图读懂"],
        } as unknown as T;
      }
      if (request.schemaName === "CoverPlan") {
        request.onUsage?.(mockUsage);
        return { candidates: defaultCoverCandidates(context.topic) } as unknown as T;
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
