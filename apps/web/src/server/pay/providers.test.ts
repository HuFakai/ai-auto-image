import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AlipayClient } from "./providers";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const testPrivateKey = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const testPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AlipayClient", () => {
  it("sends the order-code product code required by precreate", async () => {
    let requestBody = "";
    globalThis.fetch = async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          alipay_trade_precreate_response: {
            code: "10000",
            msg: "Success",
            qr_code: "https://qr.alipay.com/test",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await new AlipayClient({
      appId: "test-app-id",
      gateway: "https://openapi.alipay.com/gateway.do",
      appPrivateKey: testPrivateKey,
      alipayPublicKey: testPublicKey,
    }).precreate({
      orderNo: "order_test_001",
      amountCents: 1990,
      subject: "基础会员",
      timeoutMinutes: 15,
      notifyUrl: "https://example.com/api/pay/notify/alipay",
    });

    const params = new URLSearchParams(requestBody);
    const bizContent = JSON.parse(params.get("biz_content") ?? "{}") as Record<string, unknown>;
    expect(bizContent.product_code).toBe("QR_CODE_OFFLINE");
    expect(bizContent.total_amount).toBe("19.90");
    expect(params.get("notify_url")).toBe("https://example.com/api/pay/notify/alipay");
    expect(params.get("sign")).toBeTruthy();
  });

  it("includes Alipay sub-code details when precreate fails", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          alipay_trade_precreate_response: {
            code: "40002",
            msg: "Invalid Arguments",
            sub_code: "isv.invalid-parameter",
            sub_msg: "参数无效",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    await expect(
      new AlipayClient({
        appId: "test-app-id",
        gateway: "https://openapi.alipay.com/gateway.do",
        appPrivateKey: testPrivateKey,
        alipayPublicKey: testPublicKey,
      }).precreate({ orderNo: "order_test_002", amountCents: 1990, subject: "基础会员", timeoutMinutes: 15 }),
    ).rejects.toThrow("isv.invalid-parameter");
  });
});
