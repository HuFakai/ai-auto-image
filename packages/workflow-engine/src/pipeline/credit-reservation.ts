import type { RunRepo } from "@aai/storage";

/** workflow-engine 不依赖具体计费实现，只接收运行侧额度预留回调。 */
export interface CreditReservationDeps {
  runRepo: Pick<RunRepo, "require">;
  reserveImageCredits?: (runId: string, amount: number) => Promise<void>;
  releaseImageCredits?: (runId: string) => Promise<void>;
}

/** 将运行的预留补足到目标总量；重试时自动扣除已结算与已有预留。 */
export async function reserveCreditsToTarget(
  deps: CreditReservationDeps,
  runId: string,
  targetTotal: number,
): Promise<void> {
  if (!deps.reserveImageCredits) return;
  if (!Number.isInteger(targetTotal) || targetTotal < 0) {
    throw new Error("target credit amount must be a non-negative integer");
  }
  const run = await deps.runRepo.require(runId);
  const amount = targetTotal - run.creditsCharged - run.creditsReserved;
  if (amount > 0) await deps.reserveImageCredits(runId, amount);
}

/** 统一释放入口，清理失败时只记录日志，不覆盖原始流水线错误。 */
export async function releaseReservedCredits(
  deps: CreditReservationDeps,
  runId: string,
  log: (error: unknown) => void,
): Promise<void> {
  if (!deps.releaseImageCredits) return;
  try {
    await deps.releaseImageCredits(runId);
  } catch (error) {
    log(error);
  }
}
