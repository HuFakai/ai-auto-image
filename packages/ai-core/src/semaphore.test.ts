import { describe, expect, it } from "vitest";
import { Semaphore } from "./semaphore";

describe("Semaphore", () => {
  it("caps concurrent execution at the limit", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("tighten only lowers the limit", () => {
    const semaphore = new Semaphore(4);
    semaphore.tighten(2);
    expect(semaphore.limitValue).toBe(2);
    semaphore.tighten(3);
    expect(semaphore.limitValue).toBe(2);
  });
});
