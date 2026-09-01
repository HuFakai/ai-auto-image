import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Order } from "@aai/storage";
import { isMockPaymentAllowed, PayService } from "./service";

const mutableEnv = process.env as Record<string, string | undefined>;
const originalNodeEnv = mutableEnv.NODE_ENV;
const originalMockFlag = mutableEnv.PAYMENT_MOCK_ENABLED;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalNodeEnv === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = originalNodeEnv;
  if (originalMockFlag === undefined) delete mutableEnv.PAYMENT_MOCK_ENABLED;
  else mutableEnv.PAYMENT_MOCK_ENABLED = originalMockFlag;
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("payment mock gate", () => {
  it("is always disabled in production", () => {
    mutableEnv.NODE_ENV = "production";
    mutableEnv.PAYMENT_MOCK_ENABLED = "1";
    expect(isMockPaymentAllowed()).toBe(false);
  });

  it("is enabled for development unless explicitly disabled", () => {
    mutableEnv.NODE_ENV = "development";
    delete mutableEnv.PAYMENT_MOCK_ENABLED;
    expect(isMockPaymentAllowed()).toBe(true);
    mutableEnv.PAYMENT_MOCK_ENABLED = "0";
    expect(isMockPaymentAllowed()).toBe(false);
  });

  it("fails closed instead of silently creating a mock order in production", async () => {
    mutableEnv.NODE_ENV = "production";
    mutableEnv.PAYMENT_MOCK_ENABLED = "1";
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-pay-test-"));
    tempDirs.push(dataDir);
    let created = false;
    const service = new PayService({
      dataDir,
      paymentConfigRepo: { get: async () => undefined, upsert: async () => undefined },
      orderRepo: {
        create: async () => {
          created = true;
          throw new Error("must not create");
        },
        require: async () => { throw new Error("unused"); },
        findByOrderNo: async () => undefined,
        markPaid: async () => null,
        updateStatus: async () => { throw new Error("unused"); },
        listByUser: async () => [],
      },
      planRepo: { require: async () => { throw new Error("unused"); } },
      packageRepo: {
        require: async () => ({
          id: "pkg_test",
          name: "测试点数包",
          priceCents: 100,
          credits: 10,
          bonusCredits: 0,
          active: 1,
          sortOrder: 0,
          createdAt: 0,
          updatedAt: 0,
        }),
      },
      billing: {
        grantCreditsPurchase: async () => 0,
        activateSubscriptionPurchase: async () => undefined,
        clawback: async () => 0,
        summary: async () => ({}),
      },
      logError: () => undefined,
    });

    await expect(
      service.createOrder({ userId: "user_test", type: "credits", packageId: "pkg_test", channel: "mock" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(created).toBe(false);
  });

  it("fulfills concurrent duplicate payment notifications only once", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aai-pay-test-"));
    tempDirs.push(dataDir);
    const order: Order = {
      id: "ord_duplicate_test",
      orderNo: "NO_duplicate_test",
      userId: "user_test",
      operatorUserId: null,
      type: "credits",
      planId: null,
      packageId: "pkg_test",
      cardId: null,
      batchId: null,
      title: "测试点数包",
      amountCents: 100,
      credits: 10,
      channel: "mock",
      status: "pending",
      qrCode: null,
      channelTradeNo: null,
      failReason: null,
      paidAt: null,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    let status = order.status;
    let grants = 0;
    const service = new PayService({
      dataDir,
      paymentConfigRepo: { get: async () => undefined, upsert: async () => undefined },
      orderRepo: {
        create: async () => order,
        require: async () => ({ ...order, status }),
        findByOrderNo: async () => order,
        markPaid: async (_id, channelTradeNo) => {
          if (status !== "pending") return null;
          status = "paid";
          return { ...order, status, channelTradeNo };
        },
        updateStatus: async (_id, nextStatus) => ({ ...order, status: nextStatus }),
        listByUser: async () => [],
      },
      planRepo: { require: async () => { throw new Error("unused"); } },
      packageRepo: { require: async () => { throw new Error("unused"); } },
      billing: {
        grantCreditsPurchase: async () => {
          grants += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return 10;
        },
        activateSubscriptionPurchase: async () => undefined,
        clawback: async () => 0,
        summary: async () => ({}),
      },
      logError: () => undefined,
    });

    const results = await Promise.all([
      service.fulfillOrder(order.id, "trade_1"),
      service.fulfillOrder(order.id, "trade_1"),
    ]);
    expect(grants).toBe(1);
    expect(results.every((result) => result.status === "paid")).toBe(true);
  });
});
