import type { CreateRunInput } from "@aai/shared-schemas";
import {
  generatePlatformCopy,
  routeCreditsPerCall,
  type ExportPageFile,
  type PlatformCopy,
  type TextRoute,
} from "@aai/workflow-engine";
import type { BillingService } from "./billing";

/**
 * 生成发布文案时复用与主工作流相同的“预留 → 成功结算 → 失败释放”计费语义。
 * 发布文案不是图片节点，因此使用稳定的附加能力幂等标识作为流水 refId。
 */
export async function generateBilledPlatformCopy(args: {
  billing: BillingService;
  userId: string;
  runId: string;
  route: TextRoute;
  input: CreateRunInput;
  pages: ExportPageFile[];
  signal?: AbortSignal;
}): Promise<PlatformCopy> {
  const credits = routeCreditsPerCall(args.route);
  let reserved = false;
  try {
    if (credits > 0) {
      await args.billing.reserveRunCredits(args.userId, args.runId, credits);
      reserved = true;
    }
    const copy = await generatePlatformCopy(args.route.text, args.input, args.pages, args.signal);
    if (reserved) {
      await args.billing.captureModelCreditsForRun(
        args.runId,
        `${args.runId}:platform-copy`,
        credits,
        args.route.model,
      );
      reserved = false;
    }
    return copy;
  } catch (error) {
    if (reserved) {
      await args.billing.releaseRunCreditsAmount(args.runId, credits).catch((releaseError) => {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          msg: "release platform copy credits failed",
          runId: args.runId,
          credits,
          error: String(releaseError),
        }));
      });
    }
    throw error;
  }
}
