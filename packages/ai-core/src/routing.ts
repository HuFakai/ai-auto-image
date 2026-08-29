import type { ProviderRouteConfig } from "@aai/shared-schemas";
import { AiError, toAiError } from "./errors";

/** 一次调用尝试的记录：成功与失败都上报，写入 provider_attempts */
export interface RouteAttemptRecord {
  routeId: string;
  kind: string;
  model: string;
  attempt: number;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  statusCode?: number | undefined;
  errorCategory?: string | undefined;
  errorSummary?: string | undefined;
  providerRequestId?: string | undefined;
}

export interface FallbackRoute {
  config: ProviderRouteConfig;
  model: string;
}

export interface FallbackOptions<T> {
  routes: FallbackRoute[];
  /** 对单个路由执行一次调用（内部不要自行 catch AiError） */
  run: (route: FallbackRoute, signal?: AbortSignal) => Promise<T>;
  /** 每次尝试（含成功）的回调：调用方负责持久化到 provider_attempts */
  onAttempt?: ((record: RouteAttemptRecord) => void) | undefined;
  signal?: AbortSignal | undefined;
  /** 重试退避基数，默认 500ms */
  backoffBaseMs?: number | undefined;
}

export class ModelRouteExhaustedError extends Error {
  constructor(readonly attempts: RouteAttemptRecord[]) {
    super(
      `all routes exhausted (${attempts.length} attempts): ` +
        attempts
          .map((a) => `${a.routeId}/${a.model}#${a.attempt}: ${a.errorCategory ?? "ok"}`)
          .join("; "),
    );
    this.name = "ModelRouteExhaustedError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 多路由回退执行（借鉴 Auto-AI-Video model_routing/llm_service 的双循环）：
 * 外层遍历 preferred + fallback 路由，内层按 route.maxAttempts 重试；
 * 不可重试错误（authentication/content_policy/invalid_request）直接跳到下一路由；
 * 全部耗尽后抛出带完整尝试记录的 ModelRouteExhaustedError。
 */
export async function withModelFallbacks<T>(options: FallbackOptions<T>): Promise<T> {
  const { routes, run, onAttempt, signal } = options;
  const backoffBase = options.backoffBaseMs ?? 500;
  const attempts: RouteAttemptRecord[] = [];

  for (const route of routes) {
    const maxAttempts = Math.max(1, route.config.maxAttempts ?? 3);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) {
        throw new AiError("unknown", "aborted before attempt");
      }
      const startedAt = Date.now();
      try {
        const result = await run(route, signal);
        const record: RouteAttemptRecord = {
          routeId: route.config.id,
          kind: route.config.kind,
          model: route.model,
          attempt,
          startedAt,
          finishedAt: Date.now(),
          ok: true,
        };
        attempts.push(record);
        onAttempt?.(record);
        return result;
      } catch (error) {
        const aiError = toAiError(error);
        const record: RouteAttemptRecord = {
          routeId: route.config.id,
          kind: route.config.kind,
          model: route.model,
          attempt,
          startedAt,
          finishedAt: Date.now(),
          ok: false,
          statusCode: aiError.statusCode,
          errorCategory: aiError.category,
          errorSummary: aiError.message.slice(0, 500),
          providerRequestId: aiError.providerRequestId,
        };
        attempts.push(record);
        onAttempt?.(record);

        // 用户取消：立即终止，不重试也不切换路由
        if (signal?.aborted) throw error;

        const isLastAttempt = attempt >= maxAttempts;
        if (!aiError.retryable || isLastAttempt) break;
        const delay = Math.max(aiError.retryAfterMs ?? 0, backoffBase * 2 ** (attempt - 1));
        await sleep(delay);
      }
    }
  }

  throw new ModelRouteExhaustedError(attempts);
}
