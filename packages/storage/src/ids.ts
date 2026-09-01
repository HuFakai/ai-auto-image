import { randomUUID } from "node:crypto";

/** 生成带业务前缀的 ID，便于日志与排查 */
export function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export const newProjectId = () => prefixedId("proj");
export const newRunId = () => prefixedId("run");
export const newNodeRunId = () => prefixedId("node");
export const newPromptVersionId = () => prefixedId("prompt");
export const newAssetId = () => prefixedId("asset");
export const newAssetRelationId = () => prefixedId("rel");
export const newAttemptId = () => prefixedId("att");
export const newUsageId = () => prefixedId("usage");
export const newJobId = () => prefixedId("job");
export const newJobEventId = () => prefixedId("evt");
export const newChannelId = () => prefixedId("chn");
export const newChannelModelId = () => prefixedId("cmodel");
export const newRevisionId = () => prefixedId("rev");
export const newBrandKitId = () => prefixedId("kit");
export const newUserId = () => prefixedId("user");
export const newSessionId = () => prefixedId("sess");
export const newPlanId = () => prefixedId("plan");
export const newPackageId = () => prefixedId("pkg");
export const newOrderId = () => prefixedId("ord");
export const newWalletId = () => prefixedId("wal");
export const newSubscriptionId = () => prefixedId("sub");
export const newLedgerId = () => prefixedId("led");
export const newCardBatchId = () => prefixedId("cbatch");
export const newCardId = () => prefixedId("card");
export const newCardRedemptionId = () => prefixedId("cred");
export const newExternalApiKeyId = () => prefixedId("apikey");
export const newApiIdempotencyId = () => prefixedId("idem");
export const newCardWebhookId = () => prefixedId("cwh");
export const newCardAuditId = () => prefixedId("caudit");
