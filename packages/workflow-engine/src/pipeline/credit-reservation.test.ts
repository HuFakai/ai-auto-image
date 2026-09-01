import { describe, expect, it, vi } from "vitest";
import { reserveCreditsToTarget } from "./credit-reservation";

describe("reserveCreditsToTarget", () => {
  it("不把前置文本模型扣点当作已结算图片额度", async () => {
    const reserveImageCredits = vi.fn(async () => undefined);
    await reserveCreditsToTarget(
      {
        runRepo: {
          require: vi.fn(async () => ({ creditsCharged: 2, creditsReserved: 0 })) as never,
        },
        reserveImageCredits,
      },
      "run_test",
      7,
    );

    expect(reserveImageCredits).toHaveBeenCalledWith("run_test", 7);
  });

  it("复用本阶段已经存在的预留额度", async () => {
    const reserveImageCredits = vi.fn(async () => undefined);
    await reserveCreditsToTarget(
      {
        runRepo: {
          require: vi.fn(async () => ({ creditsCharged: 9, creditsReserved: 2 })) as never,
        },
        reserveImageCredits,
      },
      "run_test",
      7,
    );

    expect(reserveImageCredits).toHaveBeenCalledWith("run_test", 5);
  });
});
