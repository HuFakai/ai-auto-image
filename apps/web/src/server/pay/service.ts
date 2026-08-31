import type { Order, Plan, CreditPackage } from "@aai/storage";
import { decryptApiKey, encryptApiKey, getEncryptionKey } from "../channel-crypto";
import { AlipayClient, WechatPayClient, parseAlipayNotify } from "./providers";

/** 订单二维码有效期（分钟）：过期后前端引导重新下单 */
export const ORDER_TTL_MINUTES = 15;

export type PayChannel = "alipay" | "wechat" | "mock";

/**
 * mock 支付只用于本地/测试沙箱。生产环境无论请求参数还是渠道配置如何，
 * 都不能通过 mock 订单或 dev-confirm 发放真实点数。
 */
export function isMockPaymentAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.PAYMENT_MOCK_ENABLED !== "0";
}

/* ── 渠道参数解析：数据库配置优先，环境变量兜底 ─────────────── */

interface AlipaySecrets {
  appPrivateKey: string;
  alipayPublicKey: string;
}

export interface ResolvedPaymentChannel {
  channel: "alipay" | "wechat";
  enabled: boolean;
  ready: boolean;
  alipay?: AlipayConfigLike;
  wechat?: WechatConfigLike;
}

interface AlipayConfigLike extends AlipaySecrets {
  appId: string;
  gateway: string;
}

interface WechatConfigLike {
  mchid: string;
  appid: string;
  serialNo: string;
  verifyKeyId: string;
  privateKey: string;
  apiv3Key: string;
  verifyKeyPem: string;
}

function envOr(config: Record<string, string>, key: string, envKey: string): string {
  return config[key]?.trim() || process.env[envKey]?.trim() || "";
}

export interface PayServiceDeps {
  dataDir: string;
  paymentConfigRepo: {
    get(channel: string): Promise<{ enabled: number; configJson: string; secretsEncrypted: string | null } | undefined>;
    upsert(channel: string, patch: { enabled?: boolean; configJson?: string; secretsEncrypted?: string | null }): Promise<unknown>;
  };
  orderRepo: {
    create(input: Record<string, unknown>): Promise<Order>;
    require(id: string): Promise<Order>;
    findByOrderNo(orderNo: string): Promise<Order | undefined>;
    markPaid(id: string, channelTradeNo: string | null): Promise<Order | null>;
    updateStatus(id: string, status: "failed" | "refunded" | "expired" | "pending", failReason?: string): Promise<Order>;
    listByUser(userId: string, limit?: number): Promise<Order[]>;
  };
  planRepo: {
    require(id: string): Promise<Plan>;
  };
  packageRepo: {
    require(id: string): Promise<CreditPackage>;
  };
  billing: {
    grantCreditsPurchase(userId: string, credits: number, orderId: string): Promise<number>;
    activateSubscriptionPurchase(userId: string, plan: Plan, orderId: string): Promise<void>;
    clawback(userId: string, credits: number, orderId: string): Promise<number>;
    summary(userId: string): Promise<unknown>;
  };
  logError(msg: string, extra?: Record<string, unknown>): void;
}

export class PayService {
  private readonly encryptionKey: Buffer;

  constructor(private readonly deps: PayServiceDeps) {
    this.encryptionKey = getEncryptionKey(deps.dataDir);
  }

  /* ── 渠道配置 ── */

  private async readChannel(channel: "alipay" | "wechat"): Promise<{ enabled: boolean; config: Record<string, string>; secrets: Record<string, string> }> {
    const row = await this.deps.paymentConfigRepo.get(channel);
    const config = row ? (JSON.parse(row.configJson || "{}") as Record<string, string>) : {};
    let secrets: Record<string, string> = {};
    if (row?.secretsEncrypted) {
      try {
        secrets = JSON.parse(decryptApiKey(this.encryptionKey, row.secretsEncrypted)) as Record<string, string>;
      } catch (error) {
        this.deps.logError("payment secrets decrypt failed", { channel, error: String(error) });
      }
    }
    return { enabled: row?.enabled === 1, config, secrets };
  }

  /** 渠道是否已配置可真实收款（供下单路由决定走真实渠道还是 mock） */
  async resolveChannel(channel: "alipay" | "wechat"): Promise<ResolvedPaymentChannel> {
    const { enabled, config, secrets } = await this.readChannel(channel);
    if (channel === "alipay") {
      const appId = envOr(config, "appId", "ALIPAY_APP_ID");
      const gateway = envOr(config, "gateway", "ALIPAY_GATEWAY") || "https://openapi.alipay.com/gateway.do";
      const appPrivateKey = secrets.appPrivateKey?.trim() || envOr(config, "appPrivateKey", "ALIPAY_APP_PRIVATE_KEY");
      const alipayPublicKey = secrets.alipayPublicKey?.trim() || envOr(config, "alipayPublicKey", "ALIPAY_PUBLIC_KEY");
      return { channel, enabled, ready: Boolean(appId && appPrivateKey && alipayPublicKey), alipay: { appId, gateway, appPrivateKey, alipayPublicKey } };
    }
    const mchid = envOr(config, "mchid", "WECHAT_MCH_ID");
    const appid = envOr(config, "appid", "WECHAT_APPID");
    const serialNo = envOr(config, "serialNo", "WECHAT_SERIAL_NO");
    const privateKey = secrets.privateKey?.trim() || envOr(config, "privateKey", "WECHAT_PRIVATE_KEY");
    const apiv3Key = secrets.apiv3Key?.trim() || envOr(config, "apiv3Key", "WECHAT_APIV3_KEY");
    const verifyKeyPem = secrets.verifyKeyPem?.trim() || envOr(config, "verifyKeyPem", "WECHAT_PAY_PUBLIC_KEY");
    const verifyKeyId = envOr(config, "verifyKeyId", "WECHAT_PAY_PUBLIC_KEY_ID");
    return {
      channel,
      enabled,
      ready: Boolean(mchid && appid && serialNo && privateKey && apiv3Key && verifyKeyPem),
      wechat: { mchid, appid, serialNo, verifyKeyId, privateKey, apiv3Key, verifyKeyPem },
    };
  }

  /* ── 下单 ── */

  async createOrder(input: {
    userId: string;
    type: "subscription" | "credits";
    planId?: string;
    packageId?: string;
    channel: PayChannel;
  }): Promise<{ order: Order; mock: boolean }> {
    const { userId, type } = input;
    if (type === "subscription") {
      if (!input.planId) throw new PayError("缺少套餐", 400);
    } else if (!input.packageId) {
      throw new PayError("缺少点数包", 400);
    }

    let plan: Plan | null = null;
    let pkg: CreditPackage | null = null;
    if (type === "subscription") {
      plan = await this.deps.planRepo.require(input.planId!).catch(() => null);
      if (!plan || plan.active !== 1) throw new PayError("套餐不存在或已下架", 404);
    } else {
      pkg = await this.deps.packageRepo.require(input.packageId!).catch(() => null);
      if (!pkg || pkg.active !== 1) throw new PayError("点数包不存在或已下架", 404);
    }
    const amountCents = plan ? plan.priceCents : pkg!.priceCents;
    const credits = plan ? plan.creditsPerPeriod : pkg!.credits + pkg!.bonusCredits;
    const title = plan ? plan.name : pkg!.name;

    let channel: PayChannel = input.channel;
    if (channel === "mock") {
      if (!isMockPaymentAllowed()) throw new PayError("当前环境禁止使用模拟支付", 403);
    } else {
      const resolved = await this.resolveChannel(channel);
      if (!resolved.enabled || !resolved.ready) {
        if (!isMockPaymentAllowed()) {
          throw new PayError(`${channel === "alipay" ? "支付宝" : "微信"} 支付渠道未配置或未启用`, 503);
        }
        // 仅开发/测试环境允许未配置真实渠道时降级为 mock。
        channel = "mock";
      }
    }

    const expiresAt = Date.now() + ORDER_TTL_MINUTES * 60 * 1000;

    // 先建订单拿订单号，再向渠道预下单（渠道失败则订单置 failed，前端可重试）
    if (channel === "alipay") {
      const config = (await this.resolveChannel("alipay")).alipay!;
      const order = await this.deps.orderRepo.create({
        userId,
        type,
        planId: plan?.id ?? null,
        packageId: pkg?.id ?? null,
        title,
        amountCents,
        credits,
        channel,
        expiresAt,
      });
      try {
        const client = new AlipayClient(config);
        const result = await client.precreate({
          orderNo: order.orderNo,
          amountCents,
          subject: title,
          timeoutMinutes: ORDER_TTL_MINUTES,
          notifyUrl: notifyUrl("alipay"),
        });
        await this.deps.orderRepo.updateStatus(order.id, "pending");
        return { order: { ...order, qrCode: result.qrCode }, mock: false };
      } catch (error) {
        await this.deps.orderRepo.updateStatus(order.id, "failed", String(error).slice(0, 300));
        throw new PayError(`支付宝下单失败：${String(error).slice(0, 160)}`, 502);
      }
    }

    if (channel === "wechat") {
      const config = (await this.resolveChannel("wechat")).wechat!;
      const order = await this.deps.orderRepo.create({
        userId,
        type,
        planId: plan?.id ?? null,
        packageId: pkg?.id ?? null,
        title,
        amountCents,
        credits,
        channel,
        expiresAt,
      });
      try {
        const client = new WechatPayClient({
          mchid: config.mchid,
          appid: config.appid,
          serialNo: config.serialNo,
          apiv3Key: config.apiv3Key,
          privateKey: config.privateKey,
          verifyKeyPem: config.verifyKeyPem,
          verifyKeyId: config.verifyKeyId,
        });
        const result = await client.native({
          orderNo: order.orderNo,
          amountCents,
          description: title,
          expireAtMs: expiresAt,
          notifyUrl: notifyUrl("wechat"),
        });
        return { order: { ...order, qrCode: result.codeUrl }, mock: false };
      } catch (error) {
        await this.deps.orderRepo.updateStatus(order.id, "failed", String(error).slice(0, 300));
        throw new PayError(`微信支付下单失败：${String(error).slice(0, 160)}`, 502);
      }
    }

    // mock：未配置真实渠道时的沙箱模拟收款
    const order = await this.deps.orderRepo.create({
      userId,
      type,
      planId: plan?.id ?? null,
      packageId: pkg?.id ?? null,
      title,
      amountCents,
      credits,
      channel: "mock",
      expiresAt,
    });
    return { order, mock: true };
  }

  /* ── 到账（幂等） ── */

  /** pending → paid，成功后入账；重复通知返回当前订单（不重复入账） */
  async fulfillOrder(orderId: string, channelTradeNo: string | null): Promise<Order> {
    const paid = await this.deps.orderRepo.markPaid(orderId, channelTradeNo);
    if (!paid) return this.deps.orderRepo.require(orderId);
    try {
      if (paid.type === "subscription" && paid.planId) {
        const plan = await this.deps.planRepo.require(paid.planId);
        await this.deps.billing.activateSubscriptionPurchase(paid.userId, plan, paid.id);
      } else {
        await this.deps.billing.grantCreditsPurchase(paid.userId, paid.credits, paid.id);
      }
    } catch (error) {
      // 入账失败：回滚订单为 pending，等待通知重试/查单补单
      this.deps.logError("order fulfillment failed", { orderId, error: String(error) });
      await this.deps.orderRepo.updateStatus(orderId, "pending", `fulfillment failed: ${String(error).slice(0, 200)}`);
      throw error;
    }
    return this.deps.orderRepo.require(orderId);
  }

  /** 前端轮询：pending 且真实渠道时主动查单补单 */
  async queryAndUpdate(order: Order): Promise<Order> {
    if (order.status !== "pending") return order;
    if (order.channel === "alipay") {
      const resolved = await this.resolveChannel("alipay");
      if (resolved.ready && resolved.alipay) {
        const result = await new AlipayClient(resolved.alipay).query(order.orderNo);
        if (result.tradeStatus === "TRADE_SUCCESS" || result.tradeStatus === "TRADE_FINISHED") {
          return this.fulfillOrder(order.id, result.tradeNo);
        }
      }
    }
    if (order.channel === "wechat") {
      const resolved = await this.resolveChannel("wechat");
      if (resolved.ready && resolved.wechat) {
        const client = new WechatPayClient({
          mchid: resolved.wechat.mchid,
          appid: resolved.wechat.appid,
          serialNo: resolved.wechat.serialNo,
          apiv3Key: resolved.wechat.apiv3Key,
          privateKey: resolved.wechat.privateKey,
          verifyKeyPem: resolved.wechat.verifyKeyPem,
          verifyKeyId: resolved.wechat.verifyKeyId,
        });
        const result = await client.query(order.orderNo);
        if (result.tradeState === "SUCCESS") return this.fulfillOrder(order.id, result.transactionId);
      }
    }
    return order;
  }

  /** 沙箱模拟支付确认（仅 mock 订单） */
  async devConfirm(order: Order): Promise<Order> {
    if (!isMockPaymentAllowed()) throw new PayError("当前环境禁止使用模拟支付", 403);
    if (order.channel !== "mock") throw new PayError("仅模拟订单可沙箱确认", 400);
    return this.fulfillOrder(order.id, `MOCK${Date.now()}`);
  }

  /* ── 异步通知 ── */

  async handleAlipayNotify(rawBody: string): Promise<"success" | "fail"> {
    const params = parseAlipayNotify(rawBody);
    if (params.trade_status !== "TRADE_SUCCESS" && params.trade_status !== "TRADE_FINISHED") return "success";
    const resolved = await this.resolveChannel("alipay");
    if (!resolved.alipay) return "fail";
    if (!AlipayClient.verifyNotify(params, resolved.alipay.alipayPublicKey)) {
      this.deps.logError("alipay notify verify failed", { orderNo: params.out_trade_no });
      return "fail";
    }
    const order = await this.deps.orderRepo.findByOrderNo(params.out_trade_no ?? "");
    if (!order) {
      this.deps.logError("alipay notify unknown order", { orderNo: params.out_trade_no });
      return "success"; // 非本系统订单，应答成功避免反复重发
    }
    await this.fulfillOrder(order.id, params.trade_no ?? null);
    return "success";
  }

  async handleWechatNotify(
    headers: { timestamp: string; nonce: string; signature: string; serial: string },
    rawBody: string,
  ): Promise<{ ok: boolean }> {
    const resolved = await this.resolveChannel("wechat");
    if (!resolved.wechat) return { ok: false };
    if (!WechatPayClient.verifyNotify(headers, rawBody, resolved.wechat)) {
      this.deps.logError("wechatpay notify verify failed");
      return { ok: false };
    }
    const body = JSON.parse(rawBody) as { resource?: { ciphertext: string; nonce: string; associated_data?: string } };
    if (!body.resource) return { ok: false };
    const plaintext = WechatPayClient.decryptResource(body.resource, resolved.wechat.apiv3Key);
    const event = JSON.parse(plaintext) as {
      out_trade_no?: string;
      transaction_id?: string;
      trade_state?: string;
      summary?: string;
    };
    if (event.trade_state !== "SUCCESS") return { ok: true };
    const order = await this.deps.orderRepo.findByOrderNo(event.out_trade_no ?? "");
    if (!order) {
      this.deps.logError("wechatpay notify unknown order", { orderNo: event.out_trade_no });
      return { ok: true };
    }
    await this.fulfillOrder(order.id, event.transaction_id ?? null);
    return { ok: true };
  }

  /** 订单退款（后台手动）：扣回点数并置 refunded */
  async refundOrder(order: Order): Promise<Order> {
    if (order.status !== "paid") throw new PayError("仅已支付订单可退款", 400);
    await this.deps.billing.clawback(order.userId, order.credits, order.id);
    return this.deps.orderRepo.updateStatus(order.id, "refunded", "管理员退款（点数已扣回）");
  }
}

export class PayError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "PayError";
  }
}

function notifyUrl(channel: "alipay" | "wechat"): string | undefined {
  const base = process.env.PAY_NOTIFY_BASE_URL?.trim().replace(/\/$/, "");
  if (!base) return undefined;
  return `${base}/api/pay/notify/${channel}`;
}

export { encryptApiKey };
