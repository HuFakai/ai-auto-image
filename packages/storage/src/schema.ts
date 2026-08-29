import { relations } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgTable,
  real,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * PostgreSQL 方言（生产 postgres.js / 测试 PGlite 同一套 schema）。
 * 时间戳统一为 epoch 毫秒整数（bigint mode number），与原 SQLite 数据形状一致；
 * 布尔语义列保持 0/1 整数（enabled 等），Repo 层数据形状与旧版完全兼容。
 */

/** 时间戳统一为 epoch 毫秒整数 */
const createdAt = () => bigint("created_at", { mode: "number" }).notNull();

const epochColumn = (name: string) => bigint(name, { mode: "number" });

/** 一次内容创作项目（归属用户；旧数据 user_id 为空，仅管理员可见） */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [index("idx_projects_user").on(t.userId)],
);

/** 一次工作流执行；input/snapshot 为 JSON 字符串 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    inputJson: text("input_json").notNull(),
    snapshotJson: text("snapshot_json"),
    errorSummary: text("error_summary"),
    reviewStatus: text("review_status").notNull().default("pending"),
    reviewNote: text("review_note"),
    reviewedAt: epochColumn("reviewed_at"),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
    startedAt: epochColumn("started_at"),
    finishedAt: epochColumn("finished_at"),
  },
  (t) => [index("idx_workflow_runs_project").on(t.projectId)],
);

/** 单节点执行记录：输入输出、尝试次数、Provider、成本与错误 */
export const nodeRuns = pgTable(
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
    startedAt: epochColumn("started_at"),
    finishedAt: epochColumn("finished_at"),
  },
  (t) => [index("idx_node_runs_run").on(t.runId)],
);

/** Prompt 模板版本 */
export const promptVersions = pgTable(
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
export const assets = pgTable(
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
    supersededAt: epochColumn("superseded_at"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_assets_run").on(t.runId)],
);

/** 资产血缘：参考、派生、替代与版本关系 */
export const assetRelations = pgTable(
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
export const providerAttempts = pgTable(
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
    startedAt: epochColumn("started_at").notNull(),
    finishedAt: epochColumn("finished_at"),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("idx_provider_attempts_run").on(t.runId)],
);

/** Provider 用量与成本账本 */
export const providerUsages = pgTable(
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
export const jobs = pgTable(
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
    leaseExpiresAt: epochColumn("lease_expires_at"),
    lastProgressAt: epochColumn("last_progress_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_jobs_idempotency").on(t.idempotencyKey),
    index("idx_jobs_status").on(t.status),
  ],
);

/** 模型渠道（Studio 设置页管理，密钥加密落库）；type: text | image */
export const channels = pgTable(
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
    sortOrder: bigint("sort_order", { mode: "number" }).notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    imageConcurrencyMax: integer("image_concurrency_max"),
    imageEditSupport: integer("image_edit_support").notNull().default(0),
    lastTestOk: integer("last_test_ok"),
    lastTestAt: epochColumn("last_test_at"),
    lastTestDetail: text("last_test_detail"),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [index("idx_channels_type_order").on(t.type, t.sortOrder)],
);

/** 作业事件流水，供进度展示与审计 */
export const jobEvents = pgTable(
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
export const revisions = pgTable(
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

/** 品牌手册：主题、风格关键词、Logo、水印/签名/字体/色板/封面模板 */
export const brandKits = pgTable("brand_kits", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  themeId: text("theme_id").notNull().default("darkroom"),
  styleKeywordsJson: text("style_keywords_json").notNull().default("[]"),
  negativeKeywordsJson: text("negative_keywords_json").notNull().default("[]"),
  logoAssetId: text("logo_asset_id"),
  builtIn: integer("built_in").notNull().default(0),
  /** 品牌名（可与手册名不同，用于页脚/水印展示） */
  brandName: text("brand_name"),
  /** 品牌 Slogan（预览样张与页脚候选文案） */
  slogan: text("slogan"),
  /** 页脚签名，如 @账号名 */
  footerSignature: text("footer_signature"),
  /** 水印文字 */
  watermarkText: text("watermark_text"),
  /** 水印位置：corner（右下角斜置） | center（居中大字） */
  watermarkPosition: text("watermark_position").notNull().default("corner"),
  /** 水印透明度 0–1 */
  watermarkOpacity: real("watermark_opacity").notNull().default(0.18),
  /** 标题字体：default | serif | sans */
  titleFont: text("title_font").notNull().default("default"),
  /** 色板覆盖 JSON：{primary?, accent?, background?, ink?} 全可选 */
  paletteJson: text("palette_json"),
  /** 封面布局：default | big-center | split */
  coverLayout: text("cover_layout").notNull().default("default"),
  createdAt: createdAt(),
  updatedAt: epochColumn("updated_at").notNull(),
});

/** 登录用户（账号密码先行；auth_provider/provider_subject 预留微信小程序扫码） */
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("user"),
    status: text("status").notNull().default("active"),
    authProvider: text("auth_provider").notNull().default("password"),
    providerSubject: text("provider_subject"),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_users_username").on(t.username),
    uniqueIndex("uq_users_provider_subject").on(t.providerSubject),
  ],
);

/** 登录会话（服务端存 token 摘要，可随时吊销） */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    authProvider: text("auth_provider").notNull().default("password"),
    createdAt: createdAt(),
    expiresAt: epochColumn("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_sessions_token_hash").on(t.tokenHash),
    index("idx_sessions_user").on(t.userId),
  ],
);

export type Channel = typeof channels.$inferSelect;
export type BrandKit = typeof brandKits.$inferSelect;
export type Revision = typeof revisions.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;

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
