import { describe, expect, it } from "vitest";
import { Semaphore, backoffDelay } from "./concurrency";
import { errorFromStatus, AiError } from "./errors";

describe("ai-core", () => {
  it("semaphore bounds concurrency", async () => {
    const s = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        s.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
        })
      )
    );
    expect(peak).toBe(2);
  });

  it("maps provider statuses to normalized errors", () => {
    expect(errorFromStatus(401, "").code).toBe("auth");
    expect(errorFromStatus(429, "").retryable).toBe(true);
    expect(errorFromStatus(400, "content policy violation").code).toBe("content_safety");
    expect(errorFromStatus(503, "").retryable).toBe(true);
    expect(errorFromStatus(400, "bad param").retryable).toBe(false);
  });

  it("backoff grows exponentially with cap", () => {
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
    expect(backoffDelay(10)).toBe(30_000);
  });
});
