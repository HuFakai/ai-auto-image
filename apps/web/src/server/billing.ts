import type {
  LedgerRepo,
  Order,
  Plan,
  SubscriptionRepo,
  PlanRepo,
  RunRepo,
  WalletRepo,
} from "@aai/storage";

/** 与 runtime.ts 一致的结构化日志输出 */
function logError(msg: string, extra: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg, ...extra }));
}

/**
 * 计费服务：点数（1 点 = 0.1 元）为唯一消费通货。
 * - 生成一张图片扣 1 点：先在钱包中原子预留，节点成功后结算，失败/取消释放；
 * - 充值/订阅到账立即入账并记流水；
 * - 订阅按周期发点：购买/续费立即发放一期，后续周期在读余额等场景惰性补发。
 */

/** 1 点对应的人民币分 */
export const CREDIT_CENTS = 10;
/** 新用户注册赠送点数 */
export const STARTER_CREDITS = Math.max(0, Number.parseInt(process.env.STARTER_CREDITS ?? "10", 10) || 10);
/** 开始创作的最低可用余额；这里只是创建准入门槛，不代表最终作品价格。 */
export const MIN_CREATION_CREDITS = 6;

export class InsufficientCreditsError extends Error {
  constructor(public readonly balance: number, public readonly needed: number) {
    super(`insufficient credits: balance=${balance} needed=${needed}`);
    this.name = "InsufficientCreditsError";
  }
}

/** 计费结算失败标记：生成管线必须失败，不能把未扣费图片当成成功结果。 */
export class BillingCaptureError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
    this.name = "BillingCaptureError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BillingSummary {
  balance: number;
  totalGranted: number;
  totalConsumed: number;
  subscription: {
    planId: string;
    planName: string;
    creditsPerPeriod: number;
    periodDays: number;
    expiresAt: number;
    nextGrantAt: number;
  } | null;
}

export class BillingService {
  constructor(
    private readonly walletRepo: WalletRepo,
    private readonly ledgerRepo: LedgerRepo,
    private readonly planRepo: PlanRepo,
    private readonly subscriptionRepo: SubscriptionRepo,
    private readonly runRepo: RunRepo,
  ) {}

  /** 确保钱包存在（新用户发放注册点数并记流水） */
  async ensureWallet(userId: string) {
    const { wallet, created } = await this.walletRepo.ensure(userId, STARTER_CREDITS);
    if (created && wallet.balance > 0) {
      await this.ledgerRepo.append({
        userId,
        delta: wallet.balance,
        balanceAfter: wallet.balance,
        reason: "starter",
        displayTitle: "注册赠送点数",
        note: "注册赠送点数",
      });
    }
    return wallet;
  }

  /** 余额预检：不足时抛 InsufficientCreditsError（路由层转 402） */
  async precheck(userId: string, needed = 1): Promise<number> {
    const wallet = await this.ensureWallet(userId);
    const available = wallet.balance - wallet.reservedCredits;
    if (available < needed) throw new InsufficientCreditsError(available, needed);
    return available;
  }

  /**
   * 为运行追加图片额度预留。amount 是本次要新增的预留数量，
   * 钱包 UPDATE 带可用余额条件，多个并发运行不会共同透支同一批点数。
   */
  async reserveRunCredits(userId: string, runId: string, amount: number): Promise<void> {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("credit reservation amount must be a positive integer");
    const run = await this.runRepo.require(runId);
    if (run.userId && run.userId !== userId) throw new Error("run does not belong to user");
    const wallet = await this.ensureWallet(userId);
    const reserved = await this.walletRepo.reserveCredits(userId, amount);
    if (!reserved) {
      const current = await this.walletRepo.findByUser(userId);
      throw new InsufficientCreditsError(
        current ? current.balance - current.reservedCredits : wallet.balance - wallet.reservedCredits,
        amount,
      );
    }
    try {
      await this.runRepo.reserveCredits(runId, amount);
    } catch (error) {
      // 运行记录写入失败时释放钱包预留，避免额度永久冻结。
      await this.walletRepo.releaseReservedCredits(userId, amount).catch((releaseError) => {
        logError("credit reservation compensation failed", {
          runId,
          amount,
          error: String(releaseError),
        });
      });
      throw error;
    }
  }

  /** 流水线回调使用：从 run 读取归属，避免把用户身份耦合进 workflow-engine。 */
  async reserveRunCreditsForRun(runId: string, amount: number): Promise<void> {
    const run = await this.runRepo.require(runId);
    if (!run.userId) throw new Error(`run ${runId} has no billing owner`);
    await this.reserveRunCredits(run.userId, runId, amount);
  }

  /** 运行结束/失败/取消时释放仍未结算的额度；重复调用安全。 */
  async releaseRunCredits(runId: string): Promise<void> {
    const run = await this.runRepo.require(runId);
    if (!run.userId || run.creditsReserved <= 0) return;
    await this.walletRepo.releaseReservedCredits(run.userId, run.creditsReserved);
    await this.runRepo.releaseCredits(runId, run.creditsReserved);
  }

  /** 订阅惰性续期：过期置 expired；已付费周期内补发点数 */
  private async refreshSubscription(userId: string) {
    const sub = await this.subscriptionRepo.activeFor(userId);
    if (!sub) return null;
    const nowMs = Date.now();
    if (sub.expiresAt <= nowMs) {
      await this.subscriptionRepo.extend(sub.id, sub.expiresAt, sub.lastGrantAt);
      await this.subscriptionRepo.expireOverdue(nowMs);
      return null;
    }
    const plan = await this.planRepo.require(sub.planId).catch(() => null);
    if (!plan) return sub;
    const periodMs = Math.max(1, plan.periodDays) * DAY_MS;
    let lastGrantAt = sub.lastGrantAt;
    let granted = 0;
    while (lastGrantAt + periodMs <= nowMs) {
      lastGrantAt += periodMs;
      granted += plan.creditsPerPeriod;
      if (granted > 1_000_000) break; // 防御性上限
    }
    if (granted > 0) {
      await this.walletRepo.credit(userId, granted);
      const wallet = await this.walletRepo.findByUser(userId);
      await this.ledgerRepo.append({
        userId,
        delta: granted,
        balanceAfter: wallet ? wallet.balance - wallet.reservedCredits : 0,
        reason: "subscription_grant",
        refType: "subscription",
        refId: sub.id,
        note: `${plan.name}周期发放 ${plan.periodDays} 天`,
      });
      await this.subscriptionRepo.extend(sub.id, sub.expiresAt, lastGrantAt);
    }
    return sub;
  }

  /** 用户计费概览（余额 + 生效订阅；顺带做惰性发点） */
  async summary(userId: string): Promise<BillingSummary> {
    const wallet = await this.ensureWallet(userId);
    const sub = await this.refreshSubscription(userId);
    let subscription: BillingSummary["subscription"] = null;
    if (sub) {
      const plan: Plan | null = await this.planRepo.require(sub.planId).catch(() => null);
      if (plan) {
        subscription = {
          planId: plan.id,
          planName: plan.name,
          creditsPerPeriod: plan.creditsPerPeriod,
          periodDays: plan.periodDays,
          expiresAt: sub.expiresAt,
          nextGrantAt: sub.lastGrantAt + Math.max(1, plan.periodDays) * DAY_MS,
        };
      }
    }
    const fresh = (await this.walletRepo.findByUser(userId)) ?? wallet;
    return {
      balance: fresh.balance - fresh.reservedCredits,
      totalGranted: fresh.totalGranted,
      totalConsumed: fresh.totalConsumed,
      subscription,
    };
  }

  /**
   * 结算已经预留的图片额度。仅允许全额结算；没有足额预留时抛错，
   * 不再使用“余额不足扣到 0”的兜底语义。
   */
  async consumeForImages(
    userId: string,
    runId: string,
    images: number,
    refType = "workflow_node",
    refId = runId,
  ): Promise<void> {
    if (images <= 0) return;
    await this.ensureWallet(userId);
    const runState = await this.runRepo.captureReservedCredits(runId, images);
    if (!runState) {
      const wallet = await this.walletRepo.findByUser(userId);
      throw new InsufficientCreditsError(
        wallet ? wallet.balance - wallet.reservedCredits : 0,
        images,
      );
    }
    const walletState = await this.walletRepo.captureReservedCredits(userId, images);
    if (!walletState) {
      await this.runRepo.restoreCapturedCredits(runId, images).catch((restoreError) => {
        logError("run credit capture compensation failed", {
          runId,
          images,
          error: String(restoreError),
        });
      });
      throw new Error(`wallet capture failed for run ${runId}`);
    }
    try {
      const displayTitle = await this.runRepo.projectTitle(runId).catch(() => null);
      await this.ledgerRepo.append({
        userId,
        delta: -images,
        balanceAfter: walletState.available,
        reason: "consume",
        runId,
        refType,
        refId,
        displayTitle,
        note: `生图 ${images} 点`,
      });
    } catch (error) {
      // 钱包已经成功扣减时不能回滚成“免费图片”；记录错误供对账修复。
      logError("credit ledger append failed after capture", { runId, images, error: String(error) });
    }
  }

  /** 注册到 RunRepo 的「节点产出图片」钩子 */
  nodeImageHook(): (event: { runId: string; nodeRunId: string; images: number }) => Promise<void> {
    return async ({ runId, nodeRunId, images }) => {
      try {
        const run = await this.runRepo.require(runId);
        if (!run.userId) return;
        await this.consumeForImages(run.userId, runId, images, "workflow_node", nodeRunId);
      } catch (error) {
        logError("billing image charge failed", { runId, images, error: String(error) });
        await this.runRepo
          .updateStatus(runId, "failed", { errorSummary: `billing image charge failed: ${String(error).slice(0, 180)}` })
          .catch((statusError) => logError("billing failure status update failed", { runId, error: String(statusError) }));
        throw new BillingCaptureError(`billing image charge failed for run ${runId}`, error);
      }
    };
  }

  /** 订单到账：点数包入账（pay 服务在订单 pending→paid 后调用） */
  async grantCreditsPurchase(userId: string, credits: number, orderId: string): Promise<number> {
    await this.ensureWallet(userId);
    const balance = await this.walletRepo.credit(userId, credits);
    await this.ledgerRepo.append({
      userId,
      delta: credits,
      balanceAfter: balance,
      reason: "purchase",
      refType: "order",
      refId: orderId,
      note: "点数包到账",
    });
    return balance;
  }

  /** 订单到账：订阅开通/续费 + 立即发放一期点数 */
  async activateSubscriptionPurchase(userId: string, plan: Plan, orderId: string): Promise<void> {
    const nowMs = Date.now();
    await this.ensureWallet(userId);
    const existing = await this.subscriptionRepo.activeFor(userId);
    let expiresAt: number;
    let lastGrantAt: number;
    if (existing && existing.expiresAt > nowMs) {
      // 续费：在原到期日上顺延一个周期
      expiresAt = existing.expiresAt + Math.max(1, plan.periodDays) * DAY_MS;
      lastGrantAt = nowMs;
      await this.subscriptionRepo.extend(existing.id, expiresAt, lastGrantAt);
    } else {
      expiresAt = nowMs + Math.max(1, plan.periodDays) * DAY_MS;
      lastGrantAt = nowMs;
      await this.subscriptionRepo.create({ userId, planId: plan.id, startedAt: nowMs, expiresAt, lastGrantAt });
    }
    const balance = await this.walletRepo.credit(userId, plan.creditsPerPeriod);
    await this.ledgerRepo.append({
      userId,
      delta: plan.creditsPerPeriod,
      balanceAfter: balance,
      reason: "subscription_grant",
      refType: "order",
      refId: orderId,
      note: `${plan.name}开通/续费发放`,
    });
  }

  /** 管理员手工调整点数（可正可负；负数只允许扣除可用余额） */
  async adminAdjust(
    userId: string,
    delta: number,
    note: string,
    operatorUserId?: string | null,
  ): Promise<{ balance: number; orderId: string; orderNo: string; delta: number }> {
    return this.ledgerRepo.applyAdminAdjustment({
      userId,
      operatorUserId,
      delta,
      note,
      starterCredits: STARTER_CREDITS,
    });
  }

  /** 退款扣回点数（订单退款时调用；余额不足时不做部分扣减） */
  async clawback(userId: string, credits: number, orderId: string): Promise<number> {
    if (credits <= 0) {
      const wallet = await this.walletRepo.findByUser(userId);
      return wallet ? wallet.balance - wallet.reservedCredits : 0;
    }
    const { deducted, balanceAfter } = await this.walletRepo.debit(userId, credits);
    await this.ledgerRepo.append({
      userId,
      delta: -deducted,
      balanceAfter,
      reason: "refund",
      refType: "order",
      refId: orderId,
      note: deducted < credits ? `退款扣回 ${credits} 点（余额不足，实扣 ${deducted} 点）` : `退款扣回 ${credits} 点`,
    });
    return balanceAfter;
  }
}

export type { Order };

export function insufficientCreditsResponse(error: InsufficientCreditsError): Response {
  const message =
    error.needed === MIN_CREATION_CREDITS
      ? `点数不足：当前可用余额 ${error.balance} 点，开始创作至少需要 ${MIN_CREATION_CREDITS} 点。请前往「充值」购买点数或订阅套餐。`
      : `点数不足：当前可用余额 ${error.balance} 点，本次操作需要 ${error.needed} 点。请前往「充值」购买点数或订阅套餐。`;
  return Response.json(
    {
      error: message,
      code: "insufficient_credits",
      balance: error.balance,
      needed: error.needed,
    },
    { status: 402 },
  );
}

/**
 * 路由级余额预检：余额不足返回 402 响应（含 code=insufficient_credits），通过返回 null。
 * 用法：`const guard = await requireCredits(user.id); if (guard) return guard;`
 */
export async function requireCredits(userId: string, needed = 1) {
  const { getRuntime } = await import("@/server/runtime");
  const runtime = await getRuntime();
  try {
    await runtime.billing.precheck(userId, needed);
    return null;
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      return insufficientCreditsResponse(error);
    }
    throw error;
  }
}
