import { describe, expect, it, vi } from "vitest";
import type { ProviderRouteConfig } from "@aai/shared-schemas";
import { AiError } from "./errors";
import { ModelRouteExhaustedError, withModelFallbacks } from "./routing";

function route(id: string, maxAttempts = 2): { config: ProviderRouteConfig; model: string } {
  return {
    config: {
      id,
      kind: "openai",
      baseUrl: "https://api.example.com/v1",
      apiKeyRef: "TEST_KEY",
      timeoutMs: 1000,
      maxAttempts,
    },
    model: "test-model",
  };
}

describe("withModelFallbacks", () => {
  it("returns from the preferred route on success", async () => {
    const onAttempt = vi.fn();
    const result = await withModelFallbacks({
      routes: [route("a"), route("b")],
      run: async () => "ok",
      onAttempt,
    });
    expect(result).toBe("ok");
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onAttempt.mock.calls[0]?.[0].routeId).toBe("a");
  });

  it("falls through a failing route to the fallback", async () => {
    const seen: string[] = [];
    const result = await withModelFallbacks({
      routes: [route("a", 1), route("b", 1)],
      run: async (r) => {
        seen.push(r.config.id);
        if (r.config.id === "a") throw new AiError("authentication", "bad key");
        return "ok-b";
      },
      backoffBaseMs: 1,
    });
    expect(result).toBe("ok-b");
    expect(seen).toEqual(["a", "b"]);
  });

  it("retries retryable errors within a route", async () => {
    let calls = 0;
    const result = await withModelFallbacks({
      routes: [route("a", 3)],
      run: async () => {
        calls += 1;
        if (calls < 3) throw new AiError("timeout", "slow");
        return "third-time-lucky";
      },
      backoffBaseMs: 1,
    });
    expect(result).toBe("third-time-lucky");
    expect(calls).toBe(3);
  });

  it("throws ModelRouteExhaustedError with the full attempt ledger", async () => {
    const onAttempt = vi.fn();
    const promise = withModelFallbacks({
      routes: [route("a", 1), route("b", 2)],
      run: async () => {
        throw new AiError("provider_unavailable", "down");
      },
      onAttempt,
      backoffBaseMs: 1,
    });
    await expect(promise).rejects.toBeInstanceOf(ModelRouteExhaustedError);
    expect(onAttempt).toHaveBeenCalledTimes(3);
  });
});
