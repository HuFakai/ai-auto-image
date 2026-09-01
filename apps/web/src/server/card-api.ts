import type { CardBenefit } from "@aai/storage";
import type { Runtime } from "./runtime";
import { CardSystemError, parseCardBenefit } from "./card-system";

/** 解析管理端/API 传入的时间：前端可传 ISO，外部接口使用 Unix 毫秒时间戳。 */
export function parseOptionalEpoch(value: unknown, field = "expiresAt"): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? (/^\d+$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value))
      : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new CardSystemError("INVALID_REQUEST", `${field} 必须是 ISO 时间或 Unix 毫秒时间戳`);
  }
  return parsed;
}

/**
 * 会员卡权益只接受服务端套餐快照。客户端可以提交 planId，但不能伪造套餐名称、周期或发点数。
 * 这样即使套餐后来下架，已生成的卡密仍按生成时快照兑换。
 */
export async function resolveCardBenefit(runtime: Runtime, value: unknown): Promise<CardBenefit> {
  if (!value || typeof value !== "object") return parseCardBenefit(value);
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "credits") return parseCardBenefit(candidate);
  if (candidate.type !== "subscription" && candidate.type !== "combo") return parseCardBenefit(candidate);
  const planId = typeof candidate.planId === "string" ? candidate.planId.trim() : "";
  if (!planId) throw new CardSystemError("INVALID_REQUEST", "会员卡必须提供有效的 planId");
  let plan;
  try {
    plan = await runtime.planRepo.require(planId);
  } catch {
    throw new CardSystemError("INVALID_REQUEST", "套餐不存在，无法生成会员卡");
  }
  const extraCredits = candidate.type === "combo" ? Number(candidate.credits ?? 0) : undefined;
  return parseCardBenefit({
    type: candidate.type,
    planId: plan.id,
    planName: plan.name,
    periodDays: plan.periodDays,
    creditsPerPeriod: plan.creditsPerPeriod,
    ...(extraCredits === undefined ? {} : { credits: extraCredits }),
  });
}

export function cardErrorResponse(error: unknown, fallback = "卡密服务暂时不可用") {
  if (error instanceof CardSystemError) {
    return { error: error.message, code: error.code, status: error.status };
  }
  return { error: fallback, code: "INTERNAL_ERROR", status: 500 };
}

export function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CardSystemError("INVALID_REQUEST", "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

export function readString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new CardSystemError("INVALID_REQUEST", `${field} 必须是 1 到 ${maxLength} 个字符`);
  }
  return value.trim();
}

export function readOptionalString(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new CardSystemError("INVALID_REQUEST", `字段不能超过 ${maxLength} 个字符`);
  }
  return value.trim() || null;
}

export function readStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,，]/) : null;
  if (!values || values.length > maxItems || values.some((item) => typeof item !== "string" || item.length > maxLength)) {
    throw new CardSystemError("INVALID_REQUEST", "列表参数格式不合法");
  }
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export function readMetadata(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CardSystemError("INVALID_REQUEST", "metadata 必须是对象");
  }
  const json = JSON.stringify(value);
  if (json.length > 20_000) throw new CardSystemError("INVALID_REQUEST", "metadata 不能超过 20000 个字符");
  return value as Record<string, unknown>;
}

export function positiveInteger(value: unknown, field: string, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new CardSystemError("INVALID_REQUEST", `${field} 必须是 1 到 ${max} 的整数`);
  }
  return parsed;
}
