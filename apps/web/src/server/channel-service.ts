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
import type {
  Channel,
  ChannelModel,
  ChannelModelCapabilities,
  ChannelModelRepo,
  ChannelRepo,
} from "@aai/storage";
import {
  compatibleRoute,
  createOpenAICompatProvider,
  createWireClient,
  shouldDisableReasoning,
} from "@aai/provider-openai";
import { createMockProvider } from "@aai/provider-mock";
import { apiKeyHint, decryptApiKey, encryptApiKey, getEncryptionKey } from "./channel-crypto";
import type { TextRoute, ImageRoute } from "@aai/workflow-engine";
import type {
  ChannelModelCapabilitiesView,
  ChannelModelView,
  ChannelView,
  SelectableModelView,
} from "@/lib/types";

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
  /** 渠道路由优先级；数值越大越优先 */
  priority: z.number().int().min(-100_000).max(100_000).default(0),
  /** 是否允许用户在创作条自行选择该渠道的模型 */
  userModelSelectionEnabled: z.boolean().default(false),
});
export type ChannelInput = z.infer<typeof ChannelInputSchema>;

export const ChannelPatchSchema = ChannelInputSchema.partial().extend({
  // 覆盖 Create Schema 的 default，避免 PATCH 只切换启停时意外重置其他配置。
  aspectRatioParam: z.enum(["size", "aspect_ratio"]).optional(),
  responseFormat: z.enum(["url", "b64_json"]).optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  concurrencyMax: z.number().int().min(0).optional(),
  imageEditSupport: z.boolean().optional(),
  priority: z.number().int().min(-100_000).max(100_000).optional(),
  userModelSelectionEnabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type ChannelPatch = z.infer<typeof ChannelPatchSchema>;

export const ChannelModelSettingsSchema = z.object({
  providerModelId: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  priority: z.number().int().min(-100_000).max(100_000),
  creditsPerCall: z.number().int().min(0).max(100_000),
  capabilities: z.object({
    textToImage: z.boolean().optional(),
    imageEditSingle: z.boolean().optional(),
    imageEditMulti: z.boolean().optional(),
    maskEdit: z.boolean().optional(),
  }).default({}),
});
export type ChannelModelSettings = z.infer<typeof ChannelModelSettingsSchema>;

const MODEL_CATALOG_MAX_BYTES = 2_000_000;

interface DiscoveredModel {
  providerModelId: string;
  displayName: string;
  capabilities: ChannelModelCapabilities;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function booleanField(record: Record<string, unknown>, names: string[]): boolean | undefined {
  for (const name of names) {
    if (typeof record[name] === "boolean") return record[name];
  }
  return undefined;
}

function discoveredModel(entry: unknown, type: "text" | "image"): DiscoveredModel | null {
  const record = recordValue(entry);
  const providerModelId = typeof entry === "string"
    ? entry.trim()
    : [record.id, record.name, record.model].find((value): value is string => typeof value === "string")?.trim() ?? "";
  if (!providerModelId || providerModelId.length > 200) return null;
  const displayName = typeof record.display_name === "string"
    ? record.display_name.trim().slice(0, 200)
    : typeof record.displayName === "string"
      ? record.displayName.trim().slice(0, 200)
      : providerModelId;
  const nested = recordValue(record.capabilities);
  const imageEditHint = /gpt-image|image-edit|image_edit|kontext|qwen-image-edit|seedream.*edit|nano-banana.*edit/i.test(providerModelId);
  const explicitTextToImage = booleanField(record, ["textToImage", "text_to_image", "supports_text_to_image"])
    ?? booleanField(nested, ["textToImage", "text_to_image", "supports_text_to_image"]);
  const explicitSingle = booleanField(record, ["imageEditSingle", "image_edit_single", "supports_image_edit"])
    ?? booleanField(nested, ["imageEditSingle", "image_edit_single", "supports_image_edit"]);
  const explicitMulti = booleanField(record, ["imageEditMulti", "image_edit_multi", "supports_multi_image"])
    ?? booleanField(nested, ["imageEditMulti", "image_edit_multi", "supports_multi_image"]);
  const explicitMask = booleanField(record, ["maskEdit", "mask_edit", "supports_mask"])
    ?? booleanField(nested, ["maskEdit", "mask_edit", "supports_mask"]);
  return {
    providerModelId,
    displayName: displayName || providerModelId,
    capabilities: {
      textToImage: type === "image" && (explicitTextToImage ?? true),
      imageEditSingle: type === "image" && (explicitSingle ?? imageEditHint),
      imageEditMulti: type === "image" && (explicitMulti ?? imageEditHint),
      maskEdit: type === "image" && (explicitMask ?? false),
    },
  };
}

function capabilitiesView(value: string): ChannelModelCapabilitiesView {
  let parsed: ChannelModelCapabilities = {};
  try {
    const candidate: unknown = JSON.parse(value);
    if (candidate && typeof candidate === "object") parsed = candidate as ChannelModelCapabilities;
  } catch {
    // 历史/第三方目录数据损坏时按无特殊能力处理，不能阻塞后台打开渠道页。
  }
  return {
    textToImage: parsed.textToImage === true,
    imageEditSingle: parsed.imageEditSingle === true,
    imageEditMulti: parsed.imageEditMulti === true,
    maskEdit: parsed.maskEdit === true,
  };
}

/* ── 视图（密钥脱敏，ChannelView 定义见 lib/types）────────────── */

function toModelView(row: ChannelModel): ChannelModelView {
  return {
    id: row.id,
    channelId: row.channelId,
    type: row.type as "text" | "image",
    providerModelId: row.providerModelId,
    displayName: row.displayName,
    enabled: row.enabled === 1,
    isDefault: row.isDefault === 1,
    priority: row.priority,
    creditsPerCall: row.creditsPerCall,
    capabilities: capabilitiesView(row.capabilitiesJson),
    discoveredAt: row.discoveredAt,
    lastSeenAt: row.lastSeenAt,
  };
}

export class ModelSelectionError extends Error {
  constructor(
    public readonly code: "model_selection_not_allowed" | "model_not_found" | "model_capability_not_supported",
    message: string,
  ) {
    super(message);
    this.name = "ModelSelectionError";
  }
}

export interface ResolvedModelSelection {
  text?: {
    modelId: string;
    channelId: string;
    providerModelId: string;
    creditsPerCall: number;
    capabilities: ChannelModelCapabilitiesView;
  };
  image?: {
    modelId: string;
    channelId: string;
    providerModelId: string;
    creditsPerCall: number;
    capabilities: ChannelModelCapabilitiesView;
  };
}

function toView(row: Channel, modelRows: ChannelModel[] = []): ChannelView {
  const models = modelRows.map(toModelView);
  const selected = models.find((model) => model.enabled && model.isDefault);
  return {
    id: row.id,
    name: row.name,
    type: row.type as "text" | "image",
    baseUrl: row.baseUrl,
    model: selected?.providerModelId ?? (row.type === "text" ? row.textModel : row.imageModel),
    apiKeyHint: row.apiKeyHint,
    aspectRatioParam: row.aspectRatioParam,
    responseFormat: row.responseFormat,
    resolution: row.resolution,
    enabled: row.enabled === 1,
    maxAttempts: row.maxAttempts,
    concurrencyMax: row.concurrencyMax ?? 0,
    imageEditSupport: row.imageEditSupport === 1,
    priority: row.priority ?? 0,
    userModelSelectionEnabled: row.userModelSelectionEnabled === 1,
    modelsFetchedAt: row.modelsFetchedAt,
    models,
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
    private readonly modelRepo: ChannelModelRepo,
  ) {
    this.encryptionKey = getEncryptionKey(dataDir);
  }

  async list(): Promise<ChannelView[]> {
    const rows = await this.repo.list();
    const modelRows = await this.modelRepo.listByChannels(rows.map((row) => row.id));
    const grouped = new Map<string, ChannelModel[]>();
    for (const model of modelRows) {
      const list = grouped.get(model.channelId) ?? [];
      list.push(model);
      grouped.set(model.channelId, list);
    }
    return rows.map((row) => toView(row, grouped.get(row.id) ?? []));
  }

  async get(id: string): Promise<ChannelView> {
    const row = await this.repo.require(id);
    return toView(row, await this.modelRepo.listByChannel(id));
  }

  /**
   * 创作端模型目录：只返回已启用渠道且明确打开“用户自定义选模”的模型。
   * 模型 id 是数据库内部标识，客户端拿它提交选择；渠道密钥与地址不会出现在这里。
   */
  async listSelectableModels(): Promise<SelectableModelView[]> {
    const channels = await this.list();
    return channels.flatMap((channel) =>
      channel.enabled && channel.userModelSelectionEnabled
        ? channel.models
            .filter((model) => model.enabled)
            .map((model) => ({ ...model, channelName: channel.name }))
        : [],
    );
  }

  /** 校验创作端提交的模型选择，并生成写入 Run 的服务端快照。 */
  async resolveModelSelection(
    selection: { textModelId?: string; imageModelId?: string } | undefined,
    recipe: string,
  ): Promise<ResolvedModelSelection> {
    if (!selection?.textModelId && !selection?.imageModelId) return {};
    const channels = await this.list();
    const requiresImageEdit = recipe === "comic_story" || recipe === "strip_comic";
    const result: ResolvedModelSelection = {};

    const resolve = (modelId: string, type: "text" | "image") => {
      const channel = channels.find((item) => item.models.some((model) => model.id === modelId));
      if (!channel || !channel.enabled || !channel.userModelSelectionEnabled) {
        throw new ModelSelectionError(
          "model_selection_not_allowed",
          "该模型所在渠道未开启用户自定义选模，已恢复为自动选择。",
        );
      }
      const model = channel.models.find((item) => item.id === modelId);
      if (!model || !model.enabled || model.type !== type) {
        throw new ModelSelectionError("model_not_found", "所选模型不存在、已停用或类型不匹配。" );
      }
      if (type === "image" && requiresImageEdit && !model.capabilities.imageEditSingle) {
        throw new ModelSelectionError(
          "model_capability_not_supported",
          "当前内容类型需要图生图能力，请选择支持图生图的图片模型。",
        );
      }
      return {
        modelId: model.id,
        channelId: model.channelId,
        providerModelId: model.providerModelId,
        creditsPerCall: model.creditsPerCall,
        capabilities: model.capabilities,
      };
    };

    if (selection.textModelId) result.text = resolve(selection.textModelId, "text");
    if (selection.imageModelId) result.image = resolve(selection.imageModelId, "image");
    return result;
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
      priority: input.priority,
      userModelSelectionEnabled: input.userModelSelectionEnabled ? 1 : 0,
    });
    await this.modelRepo.ensureLegacyDefault(
      row.id,
      row.type,
      row.type === "text" ? row.textModel : row.imageModel,
      row.type === "image" ? { textToImage: true, imageEditSingle: row.imageEditSupport === 1, imageEditMulti: row.imageEditSupport === 1 } : undefined,
    );
    return this.get(row.id);
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
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.userModelSelectionEnabled !== undefined) {
      row.userModelSelectionEnabled = patch.userModelSelectionEnabled ? 1 : 0;
    }
    const updated = await this.repo.update(id, row);
    if (patch.textModel !== undefined || patch.imageModel !== undefined) {
      await this.modelRepo.ensureLegacyDefault(
        id,
        updated.type,
        updated.type === "text" ? updated.textModel : updated.imageModel,
        updated.type === "image" ? { textToImage: true, imageEditSingle: updated.imageEditSupport === 1, imageEditMulti: updated.imageEditSupport === 1 } : undefined,
      );
    }
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete(id);
    this.concurrencyGates.delete(id);
  }

  async reorder(orderedIds: string[]): Promise<void> {
    await this.repo.reorder(orderedIds);
  }

  /** 读取渠道模型目录并写入数据库；新模型默认未启用，管理员确认后才进入路由。 */
  async discoverModels(id: string): Promise<{ channel: ChannelView; discovered: number }> {
    const row = await this.repo.require(id);
    const models = await this.fetchModelCatalog(row);
    await this.modelRepo.discover(
      id,
      row.type,
      models.map((model) => ({
        providerModelId: model.providerModelId,
        displayName: model.displayName,
        capabilities: model.capabilities,
      })),
    );
    await this.repo.update(id, { modelsFetchedAt: Date.now() });
    return { channel: await this.get(id), discovered: models.length };
  }

  /** 保存后台选择的目录项，并同步当前兼容字段供现有路由即时生效。 */
  async saveModels(id: string, inputs: ChannelModelSettings[]): Promise<ChannelView> {
    const row = await this.repo.require(id);
    const models = await this.modelRepo.saveSettings(
      id,
      row.type,
      inputs.map((input) => ({
        providerModelId: input.providerModelId,
        enabled: input.enabled ? 1 : 0,
        isDefault: input.isDefault ? 1 : 0,
        priority: input.priority,
        creditsPerCall: input.creditsPerCall,
        capabilities: input.capabilities,
      })),
    );
    const selected = models.find((model) => model.enabled === 1 && model.isDefault === 1);
    if (selected) {
      const capabilities = capabilitiesView(selected.capabilitiesJson);
      await this.repo.update(id, row.type === "text"
        ? { textModel: selected.providerModelId }
        : {
            imageModel: selected.providerModelId,
            imageEditSupport: capabilities.imageEditSingle ? 1 : 0,
          });
    }
    return this.get(id);
  }

  /** 连通性测试：只读 GET /models（无模型调用费用） */
  async test(id: string): Promise<{ ok: boolean; detail: string; modelCount: number }> {
    const row = await this.repo.require(id);
    let ok = false;
    let detail = "";
    let modelCount = 0;
    try {
      const models = await this.fetchModelCatalog(row);
      modelCount = models.length;
      ok = true;
      detail = `连接成功${modelCount > 0 ? `，可用模型 ${modelCount} 个` : ""}`;
    } catch (error) {
      detail = error instanceof Error ? error.message.slice(0, 200) : String(error);
    }
    await this.repo.update(id, {
      lastTestOk: ok ? 1 : 0,
      lastTestAt: Date.now(),
      lastTestDetail: detail.slice(0, 300),
    });
    return { ok, detail, modelCount };
  }

  private async fetchModelCatalog(row: Channel): Promise<DiscoveredModel[]> {
    const apiKey = decryptApiKey(this.encryptionKey, row.apiKeyEncrypted);
    const response = await fetch(`${row.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "ai-auto-image/0.1" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bodyText = await response.text();
    if (new TextEncoder().encode(bodyText).byteLength > MODEL_CATALOG_MAX_BYTES) {
      throw new Error("模型目录响应过大");
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new Error("模型目录不是有效 JSON");
    }
    const entries = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : [];
    const seen = new Set<string>();
    const models: DiscoveredModel[] = [];
    for (const entry of entries) {
      const model = discoveredModel(entry, row.type as "text" | "image");
      if (!model || seen.has(model.providerModelId)) continue;
      seen.add(model.providerModelId);
      models.push(model);
    }
    return models;
  }

  /* ── 路由装配：启用渠道 → Wire Provider；缺省侧由调用方兜底 Mock ── */

  async assembleRoutes(): Promise<{
    textRoutes: TextRoute[];
    imageRoutes: ImageRoute[];
    visualQuality: VisualQualityModel | null;
    mode: "mock" | "partial" | "real";
    label: string;
  }> {
    const rows = (await this.repo.list())
      .filter((row) => row.enabled === 1)
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.sortOrder - right.sortOrder);
    const textRoutes: TextRoute[] = [];
    const imageRoutes: ImageRoute[] = [];
    let visualQuality: VisualQualityModel | null = null;

    for (const row of rows) {
      const apiKey = decryptApiKey(this.encryptionKey, row.apiKeyEncrypted);
      const discoveredModels = await this.modelRepo.listByChannel(row.id);
      const concurrencyMax = row.concurrencyMax ?? 0;
      // 同一渠道的文本、视觉检查或图片能力共享一个门；0 时不创建信号量，完全放行。
      const cachedGate = this.concurrencyGates.get(row.id);
      const concurrencyGate = cachedGate?.limit === concurrencyMax
        ? cachedGate.gate
        : createModelConcurrencyGate(concurrencyMax);
      if (!cachedGate || cachedGate.limit !== concurrencyMax) {
        this.concurrencyGates.set(row.id, { limit: concurrencyMax, gate: concurrencyGate });
      }
      const modelRows = discoveredModels.filter((model) => model.type === row.type && model.enabled === 1);

      if (row.type === "text") {
        // 迁移前没有目录项时兼容旧的 channels.text_model；有目录但全部停用时保持停用语义。
        const candidates = modelRows.length > 0
          ? modelRows
          : discoveredModels.length === 0 && row.textModel ? [null] : [];
        for (const modelRow of candidates) {
          const providerModelId = modelRow?.providerModelId ?? row.textModel;
          if (!providerModelId) continue;
          const routeId = modelRow?.id ?? row.id;
          const config: ProviderRouteConfig = compatibleRoute({
            baseUrl: row.baseUrl,
            id: routeId,
            apiKeyRef: `channel:${row.id}`,
            textModel: providerModelId,
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
              ...(shouldDisableReasoning(providerModelId)
                ? { textRequest: { disableReasoning: true } }
                : {}),
            },
          });
          textRoutes.push({
            config,
            model: bundle.text!.model,
            text: limitTextModel(bundle.text!, concurrencyGate),
            channelId: row.id,
            channelModelId: modelRow?.id,
            providerModelId,
            creditsPerCall: modelRow?.creditsPerCall ?? 1,
          });
          if (!visualQuality && bundle.visualQuality) {
            visualQuality = limitVisualQualityModel(bundle.visualQuality, concurrencyGate);
          }
        }
      }

      if (row.type === "image") {
        const candidates = modelRows.length > 0
          ? modelRows
          : discoveredModels.length === 0 && row.imageModel ? [null] : [];
        for (const modelRow of candidates) {
          const providerModelId = modelRow?.providerModelId ?? row.imageModel;
          if (!providerModelId) continue;
          const capabilities = modelRow
            ? capabilitiesView(modelRow.capabilitiesJson)
            : {
                textToImage: true,
                imageEditSingle: row.imageEditSupport === 1,
                imageEditMulti: row.imageEditSupport === 1,
                maskEdit: false,
              };
          const routeId = modelRow?.id ?? row.id;
          const config: ProviderRouteConfig = compatibleRoute({
            baseUrl: row.baseUrl,
            id: routeId,
            apiKeyRef: `channel:${row.id}`,
            imageModel: providerModelId,
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
                textToImage: capabilities.textToImage,
                imageEditSingle: capabilities.imageEditSingle,
                imageEditMulti: capabilities.imageEditMulti,
                maskEdit: capabilities.maskEdit,
                returns: ["url", "base64"],
              },
              text: { imageInput: false, structuredOutput: false },
            },
          });
          imageRoutes.push({
            config,
            model: bundle.image!.model,
            image: limitImageModel(bundle.image!, concurrencyGate),
            channelId: row.id,
            channelModelId: modelRow?.id,
            providerModelId,
            creditsPerCall: modelRow?.creditsPerCall ?? 1,
          });
        }
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
      priority: 0,
      userModelSelectionEnabled: false,
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
      priority: 0,
      userModelSelectionEnabled: false,
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
