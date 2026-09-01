import { createHash, createHmac, randomBytes } from "node:crypto";
import type { CardRepo, CardBenefit, CardBatchRecordInput, CardCodeSeed, CardIdempotencyInput } from "@aai/storage";
import { decryptApiKey, encryptApiKey, getEncryptionKey } from "./channel-crypto";

export const CARD_SETTINGS_KEYS = ["card_system_enabled", "card_redeem_enabled", "card_api_enabled"] as const;
export type CardSettingKey = (typeof CARD_SETTINGS_KEYS)[number];
export const CARD_SCOPES = ["cards:generate", "cards:read", "cards:disable"] as const;
export type CardScope = (typeof CARD_SCOPES)[number];

export interface CardSettings {
  systemEnabled: boolean;
  redeemEnabled: boolean;
  apiEnabled: boolean;
}

export class CardSystemError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "CardSystemError";
  }
}

type GeneratedCard = { cardId: string; code: string; status: "active"; expiresAt: number | null };

export interface GeneratedBatchResult {
  batchNo: string;
  batchId: string;
  name: string;
  benefit: CardBenefit;
  quantity: number;
  expiresAt: number | null;
  cards: GeneratedCard[];
}

export interface ExternalGeneratedBatchResult extends GeneratedBatchResult {
  requestId: string;
}

interface CreateBatchInput {
  name: string;
  benefit: CardBenefit;
  quantity: number;
  expiresAt?: number | null;
  salesChannel?: string | null;
  externalBatchId?: string | null;
  remark?: string | null;
  metadata?: Record<string, unknown> | null;
  actorId?: string | null;
  source: "admin" | "api";
  apiKeyId?: string | null;
}

interface ExternalRequestContext {
  apiKey: NonNullable<Awaited<ReturnType<CardRepo["getApiKeyByHash"]>>>;
  ip: string;
}

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_PREFIX = "AAI";
const MAX_ADMIN_BATCH = 1000;
const MAX_API_BATCH = 100;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;

const apiRateBuckets = new Map<string, { startedAt: number; count: number }>();
const redeemRateBuckets = new Map<string, { startedAt: number; count: number }>();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function encodeBase32(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let output = "";
  for (let index = 0; index < 26; index += 1) {
    output = CODE_ALPHABET[Number(value & 31n)] + output;
    value >>= 5n;
  }
  return output;
}

function createCardCode(): string {
  const body = encodeBase32(randomBytes(16));
  const checksum = CODE_ALPHABET[[...body].reduce((sum, char) => sum + CODE_ALPHABET.indexOf(char), 0) % 32];
  const token = `${body}${checksum}`;
  return `${CODE_PREFIX}-${token.slice(0, 5)}-${token.slice(5, 10)}-${token.slice(10, 15)}-${token.slice(15, 20)}-${token.slice(20)}`;
}

export function normalizeCardCode(input: string): string {
  const normalized = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!normalized.startsWith(CODE_PREFIX) || normalized.length !== CODE_PREFIX.length + 27) {
    throw new CardSystemError("CARD_UNAVAILABLE", "卡密无效或当前不可用", 409);
  }
  const token = normalized.slice(CODE_PREFIX.length);
  if (![...token].every((char) => CODE_ALPHABET.includes(char))) {
    throw new CardSystemError("CARD_UNAVAILABLE", "卡密无效或当前不可用", 409);
  }
  const body = token.slice(0, -1);
  const expected = CODE_ALPHABET[[...body].reduce((sum, char) => sum + CODE_ALPHABET.indexOf(char), 0) % 32];
  if (token.at(-1) !== expected) throw new CardSystemError("CARD_UNAVAILABLE", "卡密无效或当前不可用", 409);
  return normalized;
}

function formatCardCode(normalized: string): string {
  const token = normalized.slice(CODE_PREFIX.length);
  return `${CODE_PREFIX}-${token.slice(0, 5)}-${token.slice(5, 10)}-${token.slice(10, 15)}-${token.slice(15, 20)}-${token.slice(20)}`;
}

function benefitCredits(benefit: CardBenefit): number {
  if (benefit.type === "credits") return benefit.credits;
  return benefit.creditsPerPeriod + (benefit.type === "combo" ? benefit.credits : 0);
}

function validateBenefit(value: unknown): CardBenefit {
  if (!value || typeof value !== "object") throw new CardSystemError("INVALID_REQUEST", "benefit 必须是对象");
  const benefit = value as Record<string, unknown>;
  const type = benefit.type;
  if (type === "credits") {
    const credits = Number(benefit.credits);
    if (!Number.isInteger(credits) || credits <= 0 || credits > 10_000_000) {
      throw new CardSystemError("INVALID_REQUEST", "点数必须是 1 到 10000000 的整数");
    }
    return { type, credits };
  }
  if (type !== "subscription" && type !== "combo") {
    throw new CardSystemError("INVALID_REQUEST", "暂不支持该卡密权益类型");
  }
  const planId = typeof benefit.planId === "string" ? benefit.planId.trim() : "";
  const planName = typeof benefit.planName === "string" ? benefit.planName.trim() : "";
  const periodDays = Number(benefit.periodDays);
  const creditsPerPeriod = Number(benefit.creditsPerPeriod);
  const extraCredits = Number(benefit.credits ?? 0);
  if (!planId || !planName || !Number.isInteger(periodDays) || periodDays <= 0 || periodDays > 3650 || !Number.isInteger(creditsPerPeriod) || creditsPerPeriod < 0 || (type === "combo" && (!Number.isInteger(extraCredits) || extraCredits < 0))) {
    throw new CardSystemError("INVALID_REQUEST", "会员权益参数不完整或不合法");
  }
  if (type === "subscription") return { type, planId, planName, periodDays, creditsPerPeriod };
  return { type, planId, planName, periodDays, creditsPerPeriod, credits: extraCredits };
}

/** 路由层共用的权益校验；权益快照会写入批次，兑换时不再读取实时套餐价格。 */
export function parseCardBenefit(value: unknown): CardBenefit {
  return validateBenefit(value);
}

function parseList(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function takeRate(bucketMap: Map<string, { startedAt: number; count: number }>, key: string, limit: number, nowMs = Date.now()): boolean {
  if (bucketMap.size > 10_000) {
    for (const [bucketKey, bucket] of bucketMap) {
      if (nowMs - bucket.startedAt >= RATE_WINDOW_MS) bucketMap.delete(bucketKey);
    }
  }
  const safeLimit = Math.max(1, Math.min(limit, 10_000));
  const previous = bucketMap.get(key);
  if (!previous || nowMs - previous.startedAt >= RATE_WINDOW_MS) {
    bucketMap.set(key, { startedAt: nowMs, count: 1 });
    return true;
  }
  if (previous.count >= safeLimit) return false;
  previous.count += 1;
  return true;
}

function requestIp(request: Request): string {
  // 1Panel/OpenResty 使用 $proxy_add_x_forwarded_for 时，最右侧是当前反代看到的真实客户端地址；
  // 取最右侧可以避免把客户端伪造的左侧历史段当成白名单与限流依据。
  const forwarded = request.headers.get("x-forwarded-for");
  const parts = forwarded?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
  return parts.at(-1) || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export class CardSystemService {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly cardRepo: CardRepo,
    private readonly settingsRepo: { get(key: string): Promise<{ valueJson: string } | undefined>; set(key: string, valueJson: string, updatedBy?: string | null): Promise<unknown> },
    dataDir: string,
    private readonly starterCredits: number,
  ) {
    this.encryptionKey = getEncryptionKey(dataDir);
  }

  async settings(): Promise<CardSettings> {
    const read = async (key: CardSettingKey, fallback: boolean) => {
      const row = await this.settingsRepo.get(key);
      if (!row) return fallback;
      try {
        const value = JSON.parse(row.valueJson) as unknown;
        return value === true || value === 1 || value === "1";
      } catch {
        return row.valueJson === "1" || row.valueJson === "true";
      }
    };
    return {
      systemEnabled: await read("card_system_enabled", false),
      redeemEnabled: await read("card_redeem_enabled", true),
      apiEnabled: await read("card_api_enabled", false),
    };
  }

  async updateSettings(input: Partial<CardSettings>, actorId: string) {
    const mapping: Array<[CardSettingKey, boolean | undefined]> = [
      ["card_system_enabled", input.systemEnabled],
      ["card_redeem_enabled", input.redeemEnabled],
      ["card_api_enabled", input.apiEnabled],
    ];
    for (const [key, value] of mapping) {
      if (value !== undefined) await this.settingsRepo.set(key, JSON.stringify(Boolean(value)), actorId);
    }
    return this.settings();
  }

  private hashCardCode(normalized: string): string {
    return createHmac("sha256", this.encryptionKey).update(`card-code:${normalized}`).digest("hex");
  }

  private hashSensitive(value: string): string {
    return createHmac("sha256", this.encryptionKey).update(value).digest("hex");
  }

  private batchNo(): string {
    return `CB${Date.now()}${randomBytes(4).toString("hex").toUpperCase()}`;
  }

  private buildBatchInput(input: CreateBatchInput): { record: CardBatchRecordInput; result: GeneratedBatchResult } {
    const quantityLimit = input.source === "api" ? MAX_API_BATCH : MAX_ADMIN_BATCH;
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > quantityLimit) {
      throw new CardSystemError("INVALID_REQUEST", `quantity 必须是 1 到 ${quantityLimit} 的整数`);
    }
    const name = input.name.trim();
    if (!name || name.length > 100) throw new CardSystemError("INVALID_REQUEST", "批次名称不能为空且不能超过 100 个字符");
    if (input.expiresAt !== null && input.expiresAt !== undefined && (!Number.isInteger(input.expiresAt) || input.expiresAt <= Date.now())) {
      throw new CardSystemError("INVALID_REQUEST", "expiresAt 必须是未来的时间戳");
    }
    const benefit = validateBenefit(input.benefit);
    const metadataJson = JSON.stringify({
      source: input.source,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    if (metadataJson.length > 20_000) throw new CardSystemError("INVALID_REQUEST", "metadata 不能超过 20000 个字符");
    const batchId = `cbatch_${randomBytes(12).toString("hex")}`;
    const batchNo = this.batchNo();
    const expiresAt = input.expiresAt ?? null;
    const cards: CardCodeSeed[] = [];
    const resultCards: GeneratedCard[] = [];
    for (let index = 0; index < input.quantity; index += 1) {
      const code = createCardCode();
      const normalized = normalizeCardCode(code);
      const cardId = `card_${randomBytes(12).toString("hex")}`;
      cards.push({
        id: cardId,
        codeHash: this.hashCardCode(normalized),
        codePrefix: `${CODE_PREFIX}-${normalized.slice(3, 7)}`,
        codeLast4: normalized.slice(-4),
        expiresAt,
        metadataJson,
      });
      resultCards.push({ cardId, code: formatCardCode(normalized), status: "active", expiresAt });
    }
    const record: CardBatchRecordInput = {
      id: batchId,
      batchNo,
      name,
      benefitType: benefit.type,
      benefitJson: JSON.stringify(benefit),
      quantity: input.quantity,
      expiresAt,
      source: input.source,
      apiKeyId: input.apiKeyId ?? null,
      externalBatchId: input.externalBatchId?.trim() || null,
      salesChannel: input.salesChannel?.trim() || null,
      remark: input.remark?.trim() || null,
      createdBy: input.actorId ?? null,
      cards,
      audit: {
        actorType: input.source === "admin" ? "admin" : "api",
        actorId: input.actorId ?? null,
        action: "batch_created",
        apiKeyId: input.apiKeyId ?? null,
        detailJson: JSON.stringify({ quantity: input.quantity, benefitType: benefit.type, credits: benefitCredits(benefit) }),
      },
    };
    return { record, result: { batchNo, batchId, name, benefit, quantity: input.quantity, expiresAt, cards: resultCards } };
  }

  async generateAdminBatch(input: Omit<CreateBatchInput, "source"> & { actorId: string }) {
    const built = this.buildBatchInput({ ...input, source: "admin" });
    await this.cardRepo.createBatch(built.record);
    return built.result;
  }

  async generateExternalBatch(input: Omit<CreateBatchInput, "source" | "actorId"> & { apiKeyId: string; idempotencyKey: string; requestBody: unknown }) {
    const key = input.idempotencyKey.trim();
    if (!key || key.length > 128) throw new CardSystemError("INVALID_REQUEST", "Idempotency-Key 必须为 1 到 128 个字符");
    const requestHash = sha256(stableStringify(input.requestBody));
    const nowMs = Date.now();
    const existing = await this.cardRepo.getIdempotency(input.apiKeyId, key);
    if (existing && existing.expiresAt > nowMs) {
      if (existing.requestHash !== requestHash) throw new CardSystemError("IDEMPOTENCY_CONFLICT", "相同幂等键不能复用不同请求体", 409);
      try {
        return JSON.parse(decryptApiKey(this.encryptionKey, existing.responseEncrypted)) as ExternalGeneratedBatchResult;
      } catch {
        throw new CardSystemError("IDEMPOTENCY_CONFLICT", "幂等记录无法恢复，请更换幂等键", 409);
      }
    }
    if (existing) await this.cardRepo.deleteIdempotency(input.apiKeyId, key, nowMs);
    if (input.externalBatchId?.trim() && await this.cardRepo.findBatchByExternalId(input.apiKeyId, input.externalBatchId.trim())) {
      throw new CardSystemError("EXTERNAL_BATCH_EXISTS", "externalBatchId 已存在", 409);
    }
    const built = this.buildBatchInput({ ...input, source: "api", actorId: null });
    const response: ExternalGeneratedBatchResult = {
      requestId: `req_${randomBytes(10).toString("hex")}`,
      ...built.result,
    };
    const encrypted = encryptApiKey(this.encryptionKey, JSON.stringify(response));
    const idempotency: CardIdempotencyInput = {
      id: `idem_${randomBytes(12).toString("hex")}`,
      apiKeyId: input.apiKeyId,
      idempotencyKey: key,
      requestHash,
      resourceType: "card_batch",
      resourceId: built.record.id,
      responseEncrypted: encrypted,
      expiresAt: nowMs + IDEMPOTENCY_TTL_MS,
    };
    try {
      await this.cardRepo.createBatchWithIdempotency(built.record, idempotency);
      return response;
    } catch (error) {
      const concurrent = await this.cardRepo.getIdempotency(input.apiKeyId, key);
      if (concurrent && concurrent.expiresAt > Date.now() && concurrent.requestHash === requestHash) {
        return JSON.parse(decryptApiKey(this.encryptionKey, concurrent.responseEncrypted)) as ExternalGeneratedBatchResult;
      }
      if (concurrent && concurrent.expiresAt > Date.now() && concurrent.requestHash !== requestHash) {
        throw new CardSystemError("IDEMPOTENCY_CONFLICT", "相同幂等键不能复用不同请求体", 409);
      }
      if (input.externalBatchId?.trim() && String(error).toLowerCase().includes("uq_card_batches_source_external")) {
        throw new CardSystemError("EXTERNAL_BATCH_EXISTS", "externalBatchId 已存在", 409);
      }
      throw error;
    }
  }

  async redeem(userId: string, code: string, request: Request) {
    const settings = await this.settings();
    if (!settings.systemEnabled || !settings.redeemEnabled) throw new CardSystemError("CARD_SYSTEM_DISABLED", "卡密兑换功能暂未开放", 403);
    const ip = requestIp(request);
    const rateKey = `${userId}:${ip}`;
    if (!takeRate(redeemRateBuckets, rateKey, 5)) throw new CardSystemError("RATE_LIMITED", "兑换操作过于频繁，请稍后再试", 429);
    const normalized = normalizeCardCode(code);
    const matched = await this.cardRepo.findCardByHash(this.hashCardCode(normalized));
    if (!matched) throw new CardSystemError("CARD_UNAVAILABLE", "卡密无效或当前不可用", 409);
    let benefit: CardBenefit;
    try {
      benefit = validateBenefit(JSON.parse(matched.batch.benefitJson) as unknown);
    } catch {
      throw new CardSystemError("CARD_UNAVAILABLE", "卡密无效或当前不可用", 409);
    }
    const outcome = await this.cardRepo.redeem({
      codeHash: this.hashCardCode(normalized),
      userId,
      benefit,
      starterCredits: Math.max(0, this.starterCredits),
      ipHash: this.hashSensitive(ip),
      userAgentHash: this.hashSensitive(request.headers.get("user-agent") ?? "unknown"),
    });
    return outcome;
  }

  async authenticateExternal(request: Request, scope: CardScope): Promise<ExternalRequestContext> {
    const settings = await this.settings();
    if (!settings.systemEnabled || !settings.apiEnabled) throw new CardSystemError("CARD_API_DISABLED", "卡密 API 暂未开放", 403);
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token || !token.startsWith("aai_live_")) throw new CardSystemError("UNAUTHORIZED", "API Key 无效", 401);
    const apiKey = await this.cardRepo.getApiKeyByHash(sha256(token));
    const ip = requestIp(request);
    if (!apiKey || apiKey.status !== "active" || (apiKey.expiresAt !== null && apiKey.expiresAt <= Date.now())) {
      throw new CardSystemError("UNAUTHORIZED", "API Key 无效", 401);
    }
    if (!parseList(apiKey.scopesJson).includes(scope)) throw new CardSystemError("INSUFFICIENT_SCOPE", "API Key 权限不足", 403);
    const allowlist = parseList(apiKey.ipAllowlistJson);
    if (allowlist.length > 0 && !allowlist.includes(ip)) throw new CardSystemError("UNAUTHORIZED", "API Key 无效", 401);
    if (!takeRate(apiRateBuckets, apiKey.id, apiKey.rateLimitPerMinute)) throw new CardSystemError("RATE_LIMITED", "API 请求过于频繁", 429);
    await this.cardRepo.touchApiKey(apiKey.id);
    return { apiKey, ip };
  }

  async createApiKey(input: {
    name: string;
    scopes: CardScope[];
    ipAllowlist: string[];
    rateLimitPerMinute: number;
    webhookUrl?: string | null;
    expiresAt?: number | null;
    createdBy: string;
  }) {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new CardSystemError("INVALID_REQUEST", "API Key 名称不能为空且不能超过 80 个字符");
    const scopes = [...new Set(input.scopes)].filter((scope): scope is CardScope => CARD_SCOPES.includes(scope));
    if (scopes.length === 0) throw new CardSystemError("INVALID_REQUEST", "至少选择一个 API 权限");
    const rateLimit = Number(input.rateLimitPerMinute);
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 10_000) throw new CardSystemError("INVALID_REQUEST", "限流值必须是 1 到 10000 的整数");
    if (input.expiresAt !== null && input.expiresAt !== undefined && (!Number.isInteger(input.expiresAt) || input.expiresAt <= Date.now())) {
      throw new CardSystemError("INVALID_REQUEST", "API Key expiresAt 必须是未来的时间戳");
    }
    const webhookUrl = input.webhookUrl?.trim() || null;
    let webhookSecret: string | null = null;
    if (webhookUrl) {
      let parsed: URL;
      try { parsed = new URL(webhookUrl); } catch { throw new CardSystemError("INVALID_REQUEST", "Webhook 地址格式不合法"); }
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) {
        throw new CardSystemError("INVALID_REQUEST", "生产 Webhook 必须使用 HTTPS");
      }
      webhookSecret = `whsec_${randomBytes(32).toString("base64url")}`;
    }
    const token = `aai_live_${randomBytes(32).toString("base64url")}`;
    const id = `apikey_${randomBytes(12).toString("hex")}`;
    await this.cardRepo.createApiKey({
      id,
      name,
      keyPrefix: token.slice(0, 18),
      keyHash: sha256(token),
      scopesJson: JSON.stringify(scopes),
      ipAllowlistJson: JSON.stringify([...new Set(input.ipAllowlist.map((item) => item.trim()).filter(Boolean))]),
      rateLimitPerMinute: rateLimit,
      webhookUrl,
      webhookSecretEncrypted: webhookSecret ? encryptApiKey(this.encryptionKey, webhookSecret) : null,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
    });
    return { id, name, keyPrefix: token.slice(0, 18), token, webhookSecret, scopes, expiresAt: input.expiresAt ?? null };
  }

  async deliverPendingWebhooks(): Promise<void> {
    const deliveries = await this.cardRepo.claimPendingWebhooks(Date.now(), 20);
    for (const delivery of deliveries) {
      try {
        const secret = delivery.secretEncrypted ? decryptApiKey(this.encryptionKey, delivery.secretEncrypted) : "";
        const timestamp = String(Date.now());
        const signature = secret ? createHmac("sha256", secret).update(`${timestamp}.${delivery.payloadJson}`).digest("hex") : "";
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
          const response = await fetch(delivery.endpointUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-ai-event-id": delivery.eventId,
              "x-ai-event": delivery.eventType,
              "x-ai-timestamp": timestamp,
              ...(signature ? { "x-ai-signature": `sha256=${signature}` } : {}),
            },
            body: delivery.payloadJson,
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } finally {
          clearTimeout(timeout);
        }
        await this.cardRepo.markWebhookDelivered(delivery.id);
      } catch (error) {
        await this.cardRepo.markWebhookFailed(delivery.id, String(error));
      }
    }
  }
}

export function cardUnavailableMessage(code: string): string {
  switch (code) {
    case "CARD_SYSTEM_DISABLED": return "卡密兑换功能暂未开放";
    case "RATE_LIMITED": return "操作过于频繁，请稍后再试";
    default: return "卡密无效或当前不可用";
  }
}
