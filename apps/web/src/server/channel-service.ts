import { z } from "zod";
import {
  createModelConcurrencyGate,
  limitImageModel,
  limitTextModel,
  limitVisualQualityModel,
  type ModelConcurrencyGate,
  type TextModel,
  type VisualQualityModel,
} from "@aai/ai-core";
import type { ProviderRouteConfig } from "@aai/shared-schemas";
import type { Channel, ChannelRepo } from "@aai/storage";
import {
  compatibleRoute,
  createOpenAICompatProvider,
  createWireClient,
  shouldDisableReasoning,
} from "@aai/provider-openai";
import { createMockProvider } from "@aai/provider-mock";
import { apiKeyHint, decryptApiKey, encryptApiKey, getEncryptionKey } from "./channel-crypto";
import type { TextRoute, ImageRoute } from "@aai/workflow-engine";
import type { ChannelView } from "@/lib/types";

export type { ChannelView };

/* ── 输入校验 ─────────────────────────────────────────────────── */

export const ChannelInputSchema = z.object({
  name: z.string().min(1).max(60),
  type: z.enum(["text", "image"]),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).max(400),
  textModel: z.string().max(120).optional(),
  imageModel: z.string().max(120).optional(),
  aspectRatioParam: z.enum(["size", "aspect_ratio"]).default("aspect_ratio"),
  responseFormat: z.enum(["url", "b64_json"]).default("b64_json"),
  resolution: z.string().max(20).optional(),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  /** 0 表示不限制；正整数为该渠道所有模型调用共享的并发上限 */
  concurrencyMax: z.number().int().min(0).default(0),
  /** 该渠道支持图片编辑（图生图）：gpt-image 等 */
  imageEditSupport: z.boolean().default(false),
});
export type ChannelInput = z.infer<typeof ChannelInputSchema>;

export const ChannelPatchSchema = ChannelInputSchema.partial().extend({
  // 覆盖 Create Schema 的 default，避免 PATCH 只切换启停时意外重置其他配置。
  aspectRatioParam: z.enum(["size", "aspect_ratio"]).optional(),
  responseFormat: z.enum(["url", "b64_json"]).optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  concurrencyMax: z.number().int().min(0).optional(),
  imageEditSupport: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type ChannelPatch = z.infer<typeof ChannelPatchSchema>;

/* ── 视图（密钥脱敏，ChannelView 定义见 lib/types）────────────── */

function toView(row: Channel): ChannelView {
  return {
    id: row.id,
    name: row.name,
    type: row.type as "text" | "image",
    baseUrl: row.baseUrl,
    model: row.type === "text" ? row.textModel : row.imageModel,
    apiKeyHint: row.apiKeyHint,
    aspectRatioParam: row.aspectRatioParam,
    responseFormat: row.responseFormat,
    resolution: row.resolution,
    enabled: row.enabled === 1,
    maxAttempts: row.maxAttempts,
    concurrencyMax: row.concurrencyMax ?? 0,
    imageEditSupport: row.imageEditSupport === 1,
    lastTestOk: row.lastTestOk === null ? null : row.lastTestOk === 1,
    lastTestAt: row.lastTestAt,
    lastTestDetail: row.lastTestDetail,
  };
}

/* ── 渠道服务 ─────────────────────────────────────────────────── */

export class ChannelService {
  private readonly encryptionKey: Buffer;
  private readonly concurrencyGates = new Map<
    string,
    { limit: number; gate: ModelConcurrencyGate | null }
  >();

  constructor(
    private readonly repo: ChannelRepo,
    dataDir: string,
  ) {
    this.encryptionKey = getEncryptionKey(dataDir);
  }

  async list(): Promise<ChannelView[]> {
    return (await this.repo.list()).map(toView);
  }

  async get(id: string): Promise<ChannelView> {
    return toView(await this.repo.require(id));
  }

  async create(input: ChannelInput): Promise<ChannelView> {
    const row = await this.repo.create({
      name: input.name,
      type: input.type,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      apiKeyEncrypted: encryptApiKey(this.encryptionKey, input.apiKey),
      apiKeyHint: apiKeyHint(input.apiKey),
      textModel: input.type === "text" ? (input.textModel ?? null) : null,
      imageModel: input.type === "image" ? (input.imageModel ?? null) : null,
      aspectRatioParam: input.type === "image" ? input.aspectRatioParam : "aspect_ratio",
      responseFormat: input.type === "image" ? input.responseFormat : "b64_json",
      resolution: input.resolution ?? null,
      maxAttempts: input.maxAttempts,
      concurrencyMax: input.concurrencyMax,
      imageEditSupport: input.type === "image" && input.imageEditSupport ? 1 : 0,
    });
    return toView(row);
  }

  async update(id: string, patch: ChannelPatch): Promise<ChannelView> {
    const row: Record<string, unknown> = {};
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.baseUrl !== undefined) row.baseUrl = patch.baseUrl.replace(/\/+$/, "");
    if (patch.apiKey !== undefined && patch.apiKey.length > 0) {
      row.apiKeyEncrypted = encryptApiKey(this.encryptionKey, patch.apiKey);
      row.apiKeyHint = apiKeyHint(patch.apiKey);
    }
    if (patch.textModel !== undefined) row.textModel = patch.textModel || null;
    if (patch.imageModel !== undefined) row.imageModel = patch.imageModel || null;
    if (patch.aspectRatioParam !== undefined) row.aspectRatioParam = patch.aspectRatioParam;
    if (patch.responseFormat !== undefined) row.responseFormat = patch.responseFormat;
    if (patch.resolution !== undefined) row.resolution = patch.resolution || null;
    if (patch.enabled !== undefined) row.enabled = patch.enabled ? 1 : 0;
    if (patch.maxAttempts !== undefined) row.maxAttempts = patch.maxAttempts;
    if (patch.concurrencyMax !== undefined) row.concurrencyMax = patch.concurrencyMax;
    if (patch.imageEditSupport !== undefined) row.imageEditSupport = patch.imageEditSupport ? 1 : 0;
    return toView(await this.repo.update(id, row));
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
    this.concurrencyGates.delete(id);
  }

  async reorder(orderedIds: string[]): Promise<void> {
    await this.repo.reorder(orderedIds);
  }

  /** 连通性测试：只读 GET /models（无模型调用费用） */
  async test(id: string): Promise<{ ok: boolean; detail: string; modelCount: number }> {
    const row = await this.repo.require(id);
    const apiKey = decryptApiKey(this.encryptionKey, row.apiKeyEncrypted);
    let ok = false;
    let detail = "";
    let modelCount = 0;
    try {
      const response = await fetch(`${row.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "ai-auto-image/0.1" },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { data?: unknown[] };
        modelCount = Array.isArray(body.data) ? body.data.length : 0;
        ok = true;
        detail = `连接成功${modelCount > 0 ? `，可用模型 ${modelCount} 个` : ""}`;
      } else {
        detail = `HTTP ${response.status}`;
      }
    } catch (error) {
      detail = error instanceof Error ? error.message.slice(0, 200) : String(error);
    }
    this.repo.update(id, {
      lastTestOk: ok ? 1 : 0,
      lastTestAt: Date.now(),
      lastTestDetail: detail.slice(0, 300),
    });
    return { ok, detail, modelCount };
  }

  /* ── 路由装配：启用渠道 → Wire Provider；缺省侧由调用方兜底 Mock ── */

  async assembleRoutes(): Promise<{
    textRoutes: TextRoute[];
    imageRoutes: ImageRoute[];
    visualQuality: VisualQualityModel | null;
    mode: "mock" | "partial" | "real";
    label: string;
  }> {
    const rows = (await this.repo.list()).filter((row) => row.enabled === 1);
    const textRoutes: TextRoute[] = [];
    const imageRoutes: ImageRoute[] = [];
    let visualQuality: VisualQualityModel | null = null;

    for (const row of rows) {
      const apiKey = decryptApiKey(this.encryptionKey, row.apiKeyEncrypted);
      const concurrencyMax = row.concurrencyMax ?? 0;
      // 同一渠道的文本、视觉检查或图片能力共享一个门；0 时不创建信号量，完全放行。
      const cachedGate = this.concurrencyGates.get(row.id);
      const concurrencyGate = cachedGate?.limit === concurrencyMax
        ? cachedGate.gate
        : createModelConcurrencyGate(concurrencyMax);
      if (!cachedGate || cachedGate.limit !== concurrencyMax) {
        this.concurrencyGates.set(row.id, { limit: concurrencyMax, gate: concurrencyGate });
      }
      if (row.type === "text" && row.textModel) {
        const config: ProviderRouteConfig = compatibleRoute({
          baseUrl: row.baseUrl,
          id: row.id,
          apiKeyRef: `channel:${row.id}`,
          textModel: row.textModel,
          maxAttempts: row.maxAttempts,
          concurrencyMax,
          // 推理类模型生成长 JSON（如漫画分镜）可能超过 2 分钟，文本路由放宽超时
          timeoutMs: 300_000,
        });
        const bundle = createOpenAICompatProvider({
          config,
          apiKey,
          client: createWireClient(config, apiKey),
          capabilities: {
            text: { structuredOutput: true, imageInput: false },
            ...(shouldDisableReasoning(row.textModel ?? "")
              ? { textRequest: { disableReasoning: true } }
              : {}),
          },
        });
        textRoutes.push({
          config,
          model: bundle.text!.model,
          text: limitTextModel(bundle.text!, concurrencyGate),
        });
        if (!visualQuality && bundle.visualQuality) {
          visualQuality = limitVisualQualityModel(bundle.visualQuality, concurrencyGate);
        }
      }
      if (row.type === "image" && row.imageModel) {
        const config: ProviderRouteConfig = compatibleRoute({
          baseUrl: row.baseUrl,
          id: row.id,
          apiKeyRef: `channel:${row.id}`,
          imageModel: row.imageModel,
          maxAttempts: row.maxAttempts,
          concurrencyMax,
        });
        const bundle = createOpenAICompatProvider({
          config,
          apiKey,
          client: createWireClient(config, apiKey),
          capabilities: {
            imageRequest: {
              aspectRatioParam: row.aspectRatioParam === "size" ? "size" : "aspect_ratio",
              responseFormat: row.responseFormat === "url" ? "url" : "b64_json",
              ...(row.resolution ? { extraParams: { resolution: row.resolution } } : {}),
            },
            image: {
              textToImage: true,
              imageEditSingle: row.imageEditSupport === 1,
              imageEditMulti: row.imageEditSupport === 1,
              maskEdit: false,
              returns: ["url", "base64"],
            },
            text: { imageInput: false, structuredOutput: false },
          },
        });
        imageRoutes.push({
          config,
          model: bundle.image!.model,
          image: limitImageModel(bundle.image!, concurrencyGate),
        });
      }
    }

    const hasText = textRoutes.length > 0;
    const hasImage = imageRoutes.length > 0;
    const textDesc = textRoutes[0]?.model;
    const imageDesc = imageRoutes[0]?.model;
    return {
      textRoutes,
      imageRoutes,
      visualQuality,
      mode: hasText && hasImage ? "real" : hasText || hasImage ? "partial" : "mock",
      label:
        [textDesc, imageDesc].filter(Boolean).join(" + ") ||
        "Mock（未配置渠道）",
    };
  }
}

/** 从环境变量自动导入初始渠道（仅渠道表为空时执行一次） */
export async function autoImportFromEnv(service: ChannelService): Promise<number> {
  if ((await service.list()).length > 0) return 0;
  let imported = 0;
  const { TEXT_BASE_URL, TEXT_API_KEY, TEXT_MODEL, IMAGE_BASE_URL, IMAGE_API_KEY, IMAGE_MODEL } = process.env;
  if (TEXT_BASE_URL && TEXT_API_KEY) {
    await service.create({
      name: "文本渠道（自动导入）",
      type: "text",
      baseUrl: TEXT_BASE_URL,
      apiKey: TEXT_API_KEY,
      textModel: TEXT_MODEL ?? "deepseek-v4-flash",
      aspectRatioParam: "aspect_ratio",
      responseFormat: "b64_json",
      maxAttempts: 3,
      concurrencyMax: 0,
      imageEditSupport: false,
    });
    imported += 1;
  }
  if (IMAGE_BASE_URL && IMAGE_API_KEY) {
    await service.create({
      name: "图片渠道（自动导入）",
      type: "image",
      baseUrl: IMAGE_BASE_URL,
      apiKey: IMAGE_API_KEY,
      imageModel: IMAGE_MODEL ?? "grok-imagine-image-2.0",
      aspectRatioParam: (process.env.IMAGE_ASPECT_RATIO_PARAM as "size" | "aspect_ratio") ?? "aspect_ratio",
      responseFormat: (process.env.IMAGE_RESPONSE_FORMAT as "url" | "b64_json") ?? "b64_json",
      resolution: process.env.IMAGE_RESOLUTION,
      maxAttempts: 3,
      concurrencyMax: 0,
      imageEditSupport: false,
    });
    imported += 1;
  }
  return imported;
}

/** 供缺省侧兜底的 Mock 路由 */
export function mockRoutes(): { text: TextRoute; image: ImageRoute } {
  const { bundle } = createMockProvider();
  return {
    text: { config: bundle.config, model: bundle.text!.model, text: bundle.text! as TextModel },
    image: { config: bundle.config, model: bundle.image!.model, image: bundle.image! },
  };
}
