/**
 * Normalized provider errors. Every provider adapter must map its raw failures
 * into one of these codes so the workflow engine can decide retry policy.
 */
export type AiErrorCode =
  | "auth"
  | "rate_limit"
  | "content_safety"
  | "timeout"
  | "unsupported"
  | "invalid_input"
  | "upstream"
  | "unknown";

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly upstreamBody?: string;

  constructor(
    code: AiErrorCode,
    message: string,
    opts: { retryable?: boolean; status?: number; upstreamBody?: string } = {}
  ) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.retryable = opts.retryable ?? defaultRetryable(code);
    this.status = opts.status;
    this.upstreamBody = opts.upstreamBody;
  }
}

function defaultRetryable(code: AiErrorCode): boolean {
  switch (code) {
    case "rate_limit":
    case "timeout":
    case "upstream":
      return true;
    default:
      return false;
  }
}

/** Map an HTTP status from any provider into a normalized AiError. */
export function errorFromStatus(status: number, body: string): AiError {
  const snippet = body.slice(0, 500);
  if (status === 401 || status === 403) {
    return new AiError("auth", `provider auth failed (HTTP ${status})`, { status, upstreamBody: snippet });
  }
  if (status === 429) {
    return new AiError("rate_limit", "provider rate limit exceeded (429)", { status, upstreamBody: snippet });
  }
  if (status === 400) {
    if (/content|safety|policy|sensitive/i.test(body)) {
      return new AiError("content_safety", "request rejected by content safety", {
        status,
        upstreamBody: snippet,
      });
    }
    return new AiError("invalid_input", `provider rejected request (HTTP 400): ${snippet}`, {
      status,
      upstreamBody: snippet,
    });
  }
  if (status === 404) {
    return new AiError("unsupported", `provider endpoint or model not found (HTTP 404)`, {
      status,
      upstreamBody: snippet,
    });
  }
  if (status >= 500) {
    return new AiError("upstream", `provider upstream error (HTTP ${status})`, { status, upstreamBody: snippet });
  }
  return new AiError("unknown", `unexpected provider response (HTTP ${status})`, {
    status,
    upstreamBody: snippet,
  });
}
