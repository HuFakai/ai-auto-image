import {
  TRANSIENT_STATUS_CODES,
  type ProviderErrorCategory,
} from "@aai/shared-schemas";

export interface AiErrorOptions {
  statusCode?: number | undefined;
  retryAfterMs?: number | undefined;
  providerRequestId?: string | undefined;
  cause?: unknown;
}

/** 归一化后的 Provider 错误：业务层只处理这 8 类，不接触原始 SDK 类型 */
export class AiError extends Error {
  readonly statusCode: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly providerRequestId: string | undefined;

  constructor(
    readonly category: ProviderErrorCategory,
    message: string,
    options: AiErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AiError";
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
    this.providerRequestId = options.providerRequestId;
  }

  /** 是否值得在同一 Provider/路由上重试 */
  get retryable(): boolean {
    return (
      this.category === "rate_limit" ||
      this.category === "timeout" ||
      this.category === "provider_unavailable" ||
      this.category === "download_failed" ||
      this.category === "unknown"
    );
  }
}

/** 把任意异常归一化为 AiError */
export function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;

  const status = readStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";

  if (name === "AbortError" || name === "TimeoutError" || /timed? ?out/i.test(message)) {
    return new AiError("timeout", message, { statusCode: status, cause: error });
  }
  if (name === "TypeError" && /fetch|network/i.test(message)) {
    return new AiError("provider_unavailable", message, { cause: error });
  }

  if (status !== undefined) {
    const code = readErrorCode(error);
    if (status === 401 || status === 403) {
      return new AiError("authentication", message, { statusCode: status, cause: error });
    }
    if (status === 429) {
      return new AiError("rate_limit", message, {
        statusCode: status,
        retryAfterMs: readRetryAfter(error),
        cause: error,
      });
    }
    if (status === 408 || status === 504) {
      return new AiError("timeout", message, { statusCode: status, cause: error });
    }
    if (status >= 500) {
      return new AiError("provider_unavailable", message, { statusCode: status, cause: error });
    }
    if (status === 400 || status === 404 || status === 422) {
      if (code && /content_policy|content_filter|safety/i.test(code)) {
        return new AiError("content_policy", message, { statusCode: status, cause: error });
      }
      if (/content_policy|content_filter|safety/i.test(message)) {
        return new AiError("content_policy", message, { statusCode: status, cause: error });
      }
      return new AiError("invalid_request", message, { statusCode: status, cause: error });
    }
  }

  return new AiError("unknown", message, { cause: error });
}

export function isTransientStatus(status: number | undefined): boolean {
  return status !== undefined && TRANSIENT_STATUS_CODES.has(status);
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  return undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; error?: { code?: unknown } };
  if (typeof candidate.code === "string") return candidate.code;
  if (candidate.error && typeof candidate.error.code === "string") return candidate.error.code;
  return undefined;
}

function readRetryAfter(error: unknown): number | undefined {
  const headers = (error as { headers?: { get?: (k: string) => string | null } }).headers;
  const value = headers?.get?.("retry-after") ?? undefined;
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
