import { describe, expect, it } from "vitest";
import { AiError, toAiError } from "./errors";

describe("toAiError", () => {
  it("maps 401 to authentication", () => {
    const err = toAiError(Object.assign(new Error("bad key"), { status: 401 }));
    expect(err.category).toBe("authentication");
    expect(err.retryable).toBe(false);
  });

  it("maps 429 to rate_limit and marks retryable", () => {
    const err = toAiError(Object.assign(new Error("slow down"), { status: 429 }));
    expect(err.category).toBe("rate_limit");
    expect(err.retryable).toBe(true);
  });

  it("maps 500+ to provider_unavailable", () => {
    const err = toAiError(Object.assign(new Error("upstream boom"), { status: 503 }));
    expect(err.category).toBe("provider_unavailable");
    expect(err.retryable).toBe(true);
  });

  it("maps 400 with content policy code to content_policy", () => {
    const err = toAiError(
      Object.assign(new Error("rejected"), { status: 400, code: "content_policy_violation" }),
    );
    expect(err.category).toBe("content_policy");
    expect(err.retryable).toBe(false);
  });

  it("maps plain 400 to invalid_request", () => {
    const err = toAiError(Object.assign(new Error("bad param"), { status: 400 }));
    expect(err.category).toBe("invalid_request");
    expect(err.retryable).toBe(false);
  });

  it("maps AbortError to timeout", () => {
    const err = toAiError(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    expect(err.category).toBe("timeout");
    expect(err.retryable).toBe(true);
  });

  it("keeps AiError untouched", () => {
    const original = new AiError("download_failed", "no bytes");
    expect(toAiError(original)).toBe(original);
  });
});
