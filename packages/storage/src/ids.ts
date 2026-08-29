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
