import { z } from "zod";

/**
 * Job 生命周期（docs/04 §2.2）：
 * queued → running → succeeded
 *                 ├→ retry_waiting → running
 *                 ├→ needs_review
 *                 ├→ cancelled
 *                 └→ failed
 */
export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "retry_waiting",
  "needs_review",
  "succeeded",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JOB_TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/** 单个节点（NodeRun）状态 */
export const NodeRunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type NodeRunStatus = z.infer<typeof NodeRunStatusSchema>;

/** 一次工作流执行（WorkflowRun）的顶层状态；awaiting_approval = 终稿待人工确认（审批门） */
export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled"],
);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Job 类型：阶段 0 只有一条 Spike 流水线 */
export const JobKindSchema = z.enum(["knowledge_card_run"]);
export type JobKind = z.infer<typeof JobKindSchema>;

/** Spike DAG 节点名（docs/phases/00 §7） */
export const NODE_NAMES = [
  "parse-input",
  "generate-brief",
  "generate-storyboard",
  "generate-images",
  "render-slides",
  "package-export",
] as const;
export type NodeName = (typeof NODE_NAMES)[number];

/** 质量检查项统一形状（借鉴 planning.py inspect_* 输出） */
export const QualityCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["pass", "warn", "fail"]),
  detail: z.string(),
});
export type QualityCheck = z.infer<typeof QualityCheckSchema>;
