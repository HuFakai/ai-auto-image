import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
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
    let requestUrl = "";
    let requestBody = "";
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
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

    const urlParams = new URL(requestUrl).searchParams;
    const bodyParams = new URLSearchParams(requestBody);
    const params = new URLSearchParams([...urlParams.entries(), ...bodyParams.entries()]);
    const bizContent = JSON.parse(bodyParams.get("biz_content") ?? "{}") as Record<string, unknown>;
    expect(bizContent.product_code).toBe("QR_CODE_OFFLINE");
    expect(bizContent.total_amount).toBe("19.90");
    expect(urlParams.get("notify_url")).toBe("https://example.com/api/pay/notify/alipay");
    expect(urlParams.get("sign")).toBeTruthy();
    expect([...bodyParams.keys()]).toEqual(["biz_content"]);

    const requestSignSource = [...params.entries()]
      .filter(([key, value]) => key !== "sign" && value !== "")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    expect(createVerify("RSA-SHA256").update(requestSignSource, "utf8").verify(testPublicKey, urlParams.get("sign")!, "base64")).toBe(true);
  });

  it("uses the same canonical precreate request for subscriptions and credit packages", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({
          alipay_trade_precreate_response: { code: "10000", msg: "Success", qr_code: "https://qr.alipay.com/test" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const client = new AlipayClient({
      appId: "test-app-id",
      gateway: "https://openapi.alipay.com/gateway.do",
      appPrivateKey: testPrivateKey,
      alipayPublicKey: testPublicKey,
    });
    await client.precreate({ orderNo: "NO_subscription_001", amountCents: 4990, subject: "专业会员", timeoutMinutes: 15 });
    await client.precreate({ orderNo: "NO_credits_001", amountCents: 5000, subject: "标准包", timeoutMinutes: 15 });

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const urlParams = new URL(request.url).searchParams;
      const bodyParams = new URLSearchParams(request.body);
      const bizContent = JSON.parse(bodyParams.get("biz_content") ?? "{}") as Record<string, string>;
      const signSource = [...urlParams.entries(), ...bodyParams.entries()]
        .filter(([key, value]) => key !== "sign" && value !== "")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
      expect(urlParams.get("method")).toBe("alipay.trade.precreate");
      expect(bizContent.product_code).toBe("QR_CODE_OFFLINE");
      expect(createVerify("RSA-SHA256").update(signSource, "utf8").verify(testPublicKey, urlParams.get("sign")!, "base64")).toBe(true);
    }
  });

  it("rejects order data that Alipay cannot accept before signing", async () => {
    const client = new AlipayClient({
      appId: "test-app-id",
      gateway: "https://openapi.alipay.com/gateway.do",
      appPrivateKey: testPrivateKey,
      alipayPublicKey: testPublicKey,
    });

    await expect(client.precreate({ orderNo: "NO_bad_001", amountCents: 5000, subject: "标准包/赠送", timeoutMinutes: 15 })).rejects.toThrow("不能包含");
    await expect(client.precreate({ orderNo: "NO_bad_002", amountCents: 0, subject: "标准包", timeoutMinutes: 15 })).rejects.toThrow("金额");
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

  it("can validate whether the configured application key pair matches locally", () => {
    const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const otherPublicKey = otherPair.publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(AlipayClient.verifyKeyPair(testPrivateKey, testPublicKey)).toBe(true);
    expect(AlipayClient.verifyKeyPair(testPrivateKey, otherPublicKey)).toBe(false);
  });

  it("keeps sign_type out of asynchronous notification verification", () => {
    const notifyParams = {
      app_id: "test-app-id",
      charset: "utf-8",
      notify_id: "notify_test_001",
      notify_time: "2026-08-31 12:00:00",
      notify_type: "trade_status_sync",
      out_trade_no: "order_test_003",
      sign_type: "RSA2",
      subject: "基础会员",
      trade_no: "trade_test_001",
      trade_status: "TRADE_SUCCESS",
    };
    const notifySignSource = Object.entries(notifyParams)
      .filter(([key, value]) => key !== "sign_type" && value !== "")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    const sign = createSign("RSA-SHA256").update(notifySignSource, "utf8").sign(testPrivateKey, "base64");

    expect(AlipayClient.verifyNotify({ ...notifyParams, sign }, testPublicKey)).toBe(true);
  });
});
