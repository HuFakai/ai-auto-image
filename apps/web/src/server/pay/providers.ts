import { createDecipheriv, createSign, createVerify, randomBytes } from "node:crypto";

/**
 * 支付渠道客户端（扫码支付，直接返回二维码串）：
 * - 支付宝：alipay.trade.precreate（当面付·订单码），RSA2 签名，异步通知验签；
 * - 微信支付：v3 Native 下单，SHA256withRSA Authorization，回调验签 + AES-256-GCM 解密。
 *
 * 仅依赖 node:crypto 与全局 fetch，无第三方 SDK。
 * 密钥均为 PEM 文本（-----BEGIN ...-----），由支付渠道参数页加密落库。
 */

const ALIPAY_SUCCESS = "10000";

/** 北京时间 yyyy-MM-dd HH:mm:ss（支付宝 timestamp / notify 验签均按 GMT+8） */
function alipayTimestamp(date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace("T", " ").slice(0, 19);
}

/** 按 key 排序拼 k=v&k=v（不 URL 编码；值为空则跳过）——支付宝签名/验签原文 */
function alipaySignSource(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== undefined && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

function normalizePem(pem: string, label: string): string {
  const trimmed = pem.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed.replace(/\\n/g, "\n");
  // 支持粘贴纯 base64 体（64 字符换行），按常见密钥类型补头
  const body = trimmed.replace(/\s+/g, "");
  const wrapped = (body.match(/.{1,64}/g) ?? []).join("\n");
  if (label === "public") return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----`;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
}

function rsaSha256Sign(pem: string, source: string): string {
  return createSign("RSA-SHA256").update(source, "utf8").sign(normalizePem(pem, "private"), "base64");
}

function rsaSha256Verify(pem: string, source: string, signature: string): boolean {
  try {
    return createVerify("RSA-SHA256").update(source, "utf8").verify(normalizePem(pem, "public"), signature, "base64");
  } catch {
    return false;
  }
}

/* ── 支付宝 ─────────────────────────────────────────────── */

export interface AlipayConfig {
  appId: string;
  /** 正式 https://openapi.alipay.com/gateway.do；沙箱 https://openapi-sandbox.dl.alipaydev.com/gateway.do */
  gateway: string;
  appPrivateKey: string;
  alipayPublicKey: string;
}

export interface AlipayPrecreateResult {
  qrCode: string;
  tradeNo: string | null;
}

export class AlipayClient {
  constructor(private readonly config: AlipayConfig) {}

  private systemParams(bizContent: string, notifyUrl?: string): Record<string, string> {
    const params: Record<string, string> = {
      app_id: this.config.appId,
      method: "alipay.trade.precreate",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: alipayTimestamp(),
      version: "1.0",
      biz_content: bizContent,
    };
    if (notifyUrl) params.notify_url = notifyUrl;
    return params;
  }

  private async post(method: string, bizContent: Record<string, unknown>, notifyUrl?: string) {
    const params = this.systemParams(JSON.stringify(bizContent), notifyUrl);
    params.method = method;
    params.sign = rsaSha256Sign(this.config.appPrivateKey, alipaySignSource(params));
    const body = new URLSearchParams(params);
    const response = await fetch(this.config.gateway, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    return payload;
  }

  /** 预下单：返回二维码串（用户支付宝扫码） */
  async precreate(input: { orderNo: string; amountCents: number; subject: string; timeoutMinutes: number; notifyUrl?: string }): Promise<AlipayPrecreateResult> {
    const payload = await this.post(
      "alipay.trade.precreate",
      {
        out_trade_no: input.orderNo,
        total_amount: (input.amountCents / 100).toFixed(2),
        subject: input.subject,
        timeout_express: `${Math.max(1, input.timeoutMinutes)}m`,
      },
      input.notifyUrl,
    );
    const result = payload["alipay_trade_precreate_response"] as { code?: string; msg?: string; sub_msg?: string; qr_code?: string; trade_no?: string } | undefined;
    if (!result || result.code !== ALIPAY_SUCCESS || !result.qr_code) {
      throw new Error(`alipay precreate failed: ${result?.code ?? "?"} ${result?.msg ?? ""} ${result?.sub_msg ?? ""}`.trim());
    }
    return { qrCode: result.qr_code, tradeNo: result.trade_no ?? null };
  }

  /** 主动查单（对账/补单） */
  async query(orderNo: string): Promise<{ tradeStatus: string; tradeNo: string | null }> {
    const payload = await this.post("alipay.trade.query", { out_trade_no: orderNo });
    const result = payload["alipay_trade_query_response"] as { code?: string; trade_status?: string; trade_no?: string } | undefined;
    if (!result || result.code !== ALIPAY_SUCCESS) return { tradeStatus: "NOT_FOUND", tradeNo: null };
    return { tradeStatus: result.trade_status ?? "UNKNOWN", tradeNo: result.trade_no ?? null };
  }

  /** 异步通知验签：form 表单字段；成功返回 true */
  static verifyNotify(params: Record<string, string>, alipayPublicKey: string): boolean {
    const sign = params["sign"];
    if (!sign) return false;
    return rsaSha256Verify(alipayPublicKey, alipaySignSource(params), sign);
  }
}

/** 解析支付宝异步通知 body（application/x-www-form-urlencoded） */
export function parseAlipayNotify(rawBody: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(rawBody).entries());
}

/* ── 微信支付 v3 ────────────────────────────────────────── */

export interface WechatPayConfig {
  mchid: string;
  appid: string;
  /** 商户 API 证书序列号 */
  serialNo: string;
  /** APIv3 密钥（32 字节） */
  apiv3Key: string;
  /** 商户私钥 PEM（apiclient_key.pem） */
  privateKey: string;
  /** 回调验签用的微信支付公钥/平台证书 PEM */
  verifyKeyPem: string;
  /** 公钥模式：微信支付公钥 ID（PUB_KEY_ID_ 开头）；平台证书模式留空 */
  verifyKeyId?: string;
}

const WECHAT_BASE = "https://api.mch.weixin.qq.com";

export interface WechatNativeResult {
  codeUrl: string;
}

export class WechatPayClient {
  constructor(private readonly config: WechatPayConfig) {}

  private authorization(method: string, path: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomBytes(16).toString("hex");
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = rsaSha256Sign(this.config.privateKey, message);
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchid}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.config.serialNo}",signature="${signature}"`;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const response = await fetch(`${WECHAT_BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: this.authorization(method, path, payload),
        "user-agent": "ai-auto-image/1.0",
      },
      ...(method === "POST" ? { body: payload } : {}),
    });
    const text = await response.text();
    const data = (text ? JSON.parse(text) : {}) as T;
    if (!response.ok) {
      const err = data as { code?: string; message?: string };
      throw new Error(`wechatpay ${path} failed: HTTP ${response.status} ${err.code ?? ""} ${err.message ?? ""}`.trim());
    }
    return data;
  }

  private static rfc3339Gmt8(expireAtMs: number): string {
    return new Date(expireAtMs).toISOString().replace(/\.\d{3}Z$/, "+08:00");
  }

  /** Native 下单：返回 code_url（微信扫码二维码内容） */
  async native(input: { orderNo: string; amountCents: number; description: string; expireAtMs: number; notifyUrl?: string }): Promise<WechatNativeResult> {
    const result = await this.request<{ code_url: string }>("POST", "/v3/pay/transactions/native", {
      appid: this.config.appid,
      mchid: this.config.mchid,
      description: input.description.slice(0, 127),
      out_trade_no: input.orderNo,
      time_expire: WechatPayClient.rfc3339Gmt8(input.expireAtMs),
      ...(input.notifyUrl ? { notify_url: input.notifyUrl } : {}),
      amount: { total: input.amountCents, currency: "CNY" },
    });
    if (!result.code_url) throw new Error("wechatpay native failed: empty code_url");
    return { codeUrl: result.code_url };
  }

  async query(orderNo: string): Promise<{ tradeState: string; transactionId: string | null }> {
    const result = await this.request<{ trade_state?: string; transaction_id?: string }>(
      "GET",
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${this.config.mchid}`,
    );
    return { tradeState: result.trade_state ?? "UNKNOWN", transactionId: result.transaction_id ?? null };
  }

  /**
   * 回调验签：Wechatpay-Timestamp/Nonce/Signature/Serial 头 + 原始 body。
   * 平台证书模式不校验序列号；公钥模式要求 Serial 与 verifyKeyId 一致。
   */
  static verifyNotify(
    headers: { timestamp: string; nonce: string; signature: string; serial: string },
    rawBody: string,
    config: Pick<WechatPayConfig, "verifyKeyPem" | "verifyKeyId">,
  ): boolean {
    if (config.verifyKeyId && headers.serial && headers.serial !== config.verifyKeyId) return false;
    const message = `${headers.timestamp}\n${headers.nonce}\n${rawBody}\n`;
    return rsaSha256Verify(config.verifyKeyPem, message, headers.signature);
  }

  /** APIv3 AES-256-GCM 解密回调 resource（APIv3 密钥 32 字节） */
  static decryptResource(resource: { ciphertext: string; nonce: string; associated_data?: string }, apiv3Key: string): string {
    const cipher = Buffer.from(resource.ciphertext, "base64");
    const data = cipher.subarray(0, cipher.length - 16);
    const authTag = cipher.subarray(cipher.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiv3Key, "utf8"), Buffer.from(resource.nonce, "utf8"));
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(resource.associated_data ?? "", "utf8"));
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }
}
