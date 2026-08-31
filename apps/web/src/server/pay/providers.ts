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

const ALIPAY_PUBLIC_PARAMS = new Set([
  "app_id",
  "method",
  "format",
  "charset",
  "sign_type",
  "sign",
  "timestamp",
  "version",
  "notify_url",
  "return_url",
  "auth_token",
  "app_auth_token",
  "app_cert_sn",
  "alipay_root_cert_sn",
  "ws_service_url",
]);

/** 北京时间 yyyy-MM-dd HH:mm:ss（支付宝 timestamp / notify 验签均按 GMT+8） */
function alipayTimestamp(date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * API 请求签名原文：按 key 排序拼 k=v&k=v（不 URL 编码；值为空则跳过）。
 * OpenAPI 2.0 只剔除 sign，sign_type 必须参与请求签名。
 */
function alipayRequestSignSource(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== "sign" && params[key] !== undefined && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

/** 订单异步通知验签原文：支付宝 V1 通知规范会同时剔除 sign 与 sign_type。 */
function alipayNotifySignSource(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== undefined && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

/**
 * 订单码接口允许的订单标题：支付宝要求标题非空，且不能包含 /、=、&。
 * 统一在服务端规范化，避免后台录入的不可见空白或保留字符进入签名原文。
 */
export function normalizeAlipaySubject(subject: string): string {
  const normalized = subject.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("支付宝订单标题不能为空");
  if (/[\/=&]/u.test(normalized)) throw new Error("支付宝订单标题不能包含 /、=、&");
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) throw new Error("支付宝订单标题不能包含控制字符");
  if (Buffer.byteLength(normalized, "utf8") > 256) throw new Error("支付宝订单标题不能超过 256 字节");
  return normalized;
}

function normalizeAlipayOrderNo(orderNo: string): string {
  const normalized = orderNo.trim();
  if (!/^[A-Za-z0-9_]{1,64}$/u.test(normalized)) {
    throw new Error("支付宝商户订单号只能包含字母、数字和下划线，且不超过 64 位");
  }
  return normalized;
}

function validateAlipayAmount(amountCents: number): void {
  // 官方金额范围为 0.01～100000000 元；本项目金额统一使用整数分。
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 10_000_000_000) {
    throw new Error("支付宝订单金额必须为 0.01～100000000 元");
  }
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

export class AlipayApiError extends Error {
  constructor(
    message: string,
    public readonly details: {
      code?: string;
      msg?: string;
      subCode?: string;
      subMsg?: string;
    } = {},
  ) {
    super(message);
    this.name = "AlipayApiError";
  }
}

export class AlipayClient {
  constructor(private readonly config: AlipayConfig) {}

  /** 仅在服务端做密钥配对自检，不上传或记录任何密钥内容。 */
  static verifyKeyPair(appPrivateKey: string, alipayPublicKey: string): boolean {
    const probe = `ai-auto-image-key-check:${randomBytes(16).toString("hex")}`;
    try {
      const signature = rsaSha256Sign(appPrivateKey, probe);
      return rsaSha256Verify(alipayPublicKey, probe, signature);
    } catch {
      return false;
    }
  }

  private systemParams(method: string, bizContent: string, notifyUrl?: string): Record<string, string> {
    const params: Record<string, string> = {
      app_id: this.config.appId,
      method,
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
    const params = this.systemParams(method, JSON.stringify(bizContent), notifyUrl);
    params.sign = rsaSha256Sign(this.config.appPrivateKey, alipayRequestSignSource(params));
    // 与支付宝官方 Node SDK 保持一致：公共参数放在 URL，biz_content 放在 POST body。
    // 这样可避免网关在 form body 中再次规范化公共参数，导致签名原文不一致。
    const requestUrl = new URL(this.config.gateway);
    const bodyParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (ALIPAY_PUBLIC_PARAMS.has(key)) requestUrl.searchParams.set(key, value);
      else bodyParams[key] = value;
    }
    const body = new URLSearchParams(bodyParams);
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        accept: "application/json",
        "user-agent": "ai-auto-image/1.0",
      },
      body: body.toString(),
    });
    const rawResponse = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawResponse) as Record<string, unknown>;
    } catch {
      throw new Error(`alipay ${method} returned invalid JSON (HTTP ${response.status})`);
    }
    return payload;
  }

  /** 预下单：返回二维码串（用户支付宝扫码） */
  async precreate(input: { orderNo: string; amountCents: number; subject: string; timeoutMinutes: number; notifyUrl?: string }): Promise<AlipayPrecreateResult> {
    const orderNo = normalizeAlipayOrderNo(input.orderNo);
    const subject = normalizeAlipaySubject(input.subject);
    validateAlipayAmount(input.amountCents);
    const payload = await this.post(
      "alipay.trade.precreate",
      {
        out_trade_no: orderNo,
        total_amount: (input.amountCents / 100).toFixed(2),
        subject,
        // 订单码支付的产品码是支付宝接口必填项，不能省略。
        product_code: "QR_CODE_OFFLINE",
        timeout_express: `${Math.max(1, input.timeoutMinutes)}m`,
      },
      input.notifyUrl,
    );
    const result = (payload["alipay_trade_precreate_response"] ?? payload.error_response) as {
      code?: string;
      msg?: string;
      sub_code?: string;
      sub_msg?: string;
      qr_code?: string;
      trade_no?: string;
    } | undefined;
    if (!result || result.code !== ALIPAY_SUCCESS || !result.qr_code) {
      throw new AlipayApiError(
        `alipay precreate failed: ${result?.code ?? "?"} ${result?.msg ?? ""} ${result?.sub_code ?? ""} ${result?.sub_msg ?? ""}`.trim(),
        {
          code: result?.code,
          msg: result?.msg,
          subCode: result?.sub_code,
          subMsg: result?.sub_msg,
        },
      );
    }
    return { qrCode: result.qr_code, tradeNo: result.trade_no ?? null };
  }

  /** 主动查单（对账/补单） */
  async query(orderNo: string): Promise<{ tradeStatus: string; tradeNo: string | null }> {
    const payload = await this.post("alipay.trade.query", { out_trade_no: normalizeAlipayOrderNo(orderNo) });
    const result = (payload["alipay_trade_query_response"] ?? payload.error_response) as { code?: string; trade_status?: string; trade_no?: string } | undefined;
    if (!result || result.code !== ALIPAY_SUCCESS) return { tradeStatus: "NOT_FOUND", tradeNo: null };
    return { tradeStatus: result.trade_status ?? "UNKNOWN", tradeNo: result.trade_no ?? null };
  }

  /** 异步通知验签：form 表单字段；成功返回 true */
  static verifyNotify(params: Record<string, string>, alipayPublicKey: string): boolean {
    const sign = params["sign"];
    if (!sign) return false;
    return rsaSha256Verify(alipayPublicKey, alipayNotifySignSource(params), sign);
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
