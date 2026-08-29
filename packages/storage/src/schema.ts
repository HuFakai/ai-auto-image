import { relations } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** 时间戳统一为 epoch 毫秒整数 */
const createdAt = () => integer("created_at").notNull();

/** 一次内容创作项目 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: integer("updated_at").notNull(),
});

/** 一次工作流执行；input/snapshot 为 JSON 字符串 */
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    inputJson: text("input_json").notNull(),
    snapshotJson: text("snapshot_json"),
    errorSummary: text("error_summary"),
    reviewStatus: text("review_status").notNull().default("pending"),
    reviewNote: text("review_note"),
    reviewedAt: integer("reviewed_at"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("idx_workflow_runs_project").on(t.projectId)],
);

/** 单节点执行记录：输入输出、尝试次数、Provider、成本与错误 */
export const nodeRuns = sqliteTable(
  "node_runs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    nodeName: text("node_name").notNull(),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    inputRef: text("input_ref"),
    outputRef: text("output_ref"),
    routeId: text("route_id"),
    model: text("model"),
    promptVersionId: text("prompt_version_id"),
    errorCategory: text("error_category"),
    errorSummary: text("error_summary"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    images: integer("images").notNull().default(0),
    costUsd: real("cost_usd"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("idx_node_runs_run").on(t.runId)],
);

/** Prompt 模板版本 */
export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    id: text("id").primaryKey(),
    nodeName: text("node_name").notNull(),
    version: integer("version").notNull(),
    template: text("template").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("uq_prompt_node_version").on(t.nodeName, t.version)],
);

/** 资产：原始、生成、合成与导出文件 */
export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").references(() => workflowRuns.id, {
      onDelete: "cascade",
    }),
    nodeRunId: text("node_run_id").references(() => nodeRuns.id, {
      onDelete: "set null",
    }),
    pageIndex: integer("page_index"),
    kind: text("kind").notNull(),
    filePath: text("file_path").notNull(),
    mimeType: text("mime_type").notNull().default("image/png"),
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes").notNull().default(0),
    checksum: text("checksum"),
    metadataJson: text("metadata_json"),
    supersededAt: integer("superseded_at"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_assets_run").on(t.runId)],
);

/** 资产血缘：参考、派生、替代与版本关系 */
export const assetRelations = sqliteTable(
  "asset_relations",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    relatedAssetId: text("related_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("idx_asset_relations_asset").on(t.assetId)],
);

/** 每次 Provider 调用尝试：成功与失败都记录，不只记最终成功者 */
export const providerAttempts = sqliteTable(
  "provider_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    nodeRunId: text("node_run_id"),
    routeId: text("route_id").notNull(),
    kind: text("kind").notNull(),
    model: text("model"),
    attempt: integer("attempt").notNull().default(1),
    statusCode: integer("status_code"),
    errorCategory: text("error_category"),
    errorSummary: text("error_summary"),
    providerRequestId: text("provider_request_id"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("idx_provider_attempts_run").on(t.runId)],
);

/** Provider 用量与成本账本 */
export const providerUsages = sqliteTable(
  "provider_usages",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    nodeRunId: text("node_run_id"),
    routeId: text("route_id").notNull(),
    model: text("model"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    images: integer("images").notNull().default(0),
    costUsd: real("cost_usd"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_provider_usages_run").on(t.runId)],
);

/** 可恢复作业；租约字段防止多实例重复执行 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    runId: text("run_id").references(() => workflowRuns.id, {
      onDelete: "cascade",
    }),
    status: text("status").notNull().default("queued"),
    payloadJson: text("payload_json"),
    idempotencyKey: text("idempotency_key"),
    attempts: integer("attempts").notNull().default(0),
    recoveries: integer("recoveries").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseHolder: text("lease_holder"),
    leaseExpiresAt: integer("lease_expires_at"),
    lastProgressAt: integer("last_progress_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_jobs_idempotency").on(t.idempotencyKey),
    index("idx_jobs_status").on(t.status),
  ],
);

/** 模型渠道（Studio 设置页管理，密钥加密落库）；type: text | image */
export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    apiKeyHint: text("api_key_hint").notNull().default(""),
    textModel: text("text_model"),
    imageModel: text("image_model"),
    aspectRatioParam: text("aspect_ratio_param").notNull().default("aspect_ratio"),
    responseFormat: text("response_format").notNull().default("b64_json"),
    resolution: text("resolution"),
    enabled: integer("enabled").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    imageConcurrencyMax: integer("image_concurrency_max"),
    imageEditSupport: integer("image_edit_support").notNull().default(0),
    lastTestOk: integer("last_test_ok"),
    lastTestAt: integer("last_test_at"),
    lastTestDetail: text("last_test_detail"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_channels_type_order").on(t.type, t.sortOrder)],
);

/** 作业事件流水，供进度展示与审计 */
export const jobEvents = sqliteTable(
  "job_events",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_job_events_job").on(t.jobId)],
);

/** 单页返修版本链：保留每次返修的输入与产物 */
export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    pageIndex: integer("page_index").notNull(),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json"),
    assetId: text("asset_id").references(() => assets.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("idx_revisions_run_page").on(t.runId, t.pageIndex)],
);

/** 品牌手册：主题、风格关键词与 Logo */
export const brandKits = sqliteTable("brand_kits", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  themeId: text("theme_id").notNull().default("darkroom"),
  styleKeywordsJson: text("style_keywords_json").notNull().default("[]"),
  negativeKeywordsJson: text("negative_keywords_json").notNull().default("[]"),
  logoAssetId: text("logo_asset_id"),
  builtIn: integer("built_in").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: integer("updated_at").notNull(),
});

export type Channel = typeof channels.$inferSelect;
export type BrandKit = typeof brandKits.$inferSelect;
export type Revision = typeof revisions.$inferSelect;

export const workflowRunsRelations = relations(workflowRuns, ({ many }) => ({
  nodeRuns: many(nodeRuns),
  assets: many(assets),
}));

export const nodeRunsRelations = relations(nodeRuns, ({ one }) => ({
  run: one(workflowRuns, {
    fields: [nodeRuns.runId],
    references: [workflowRuns.id],
  }),
}));
