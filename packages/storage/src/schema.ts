import { relations } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgTable,
  real,
  text,
  uniqueIndex,
  type AnyPgColumn,
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
    /** 当前运行尚未结算的图片额度；余额预留与图片成功结算分离 */
    creditsReserved: integer("credits_reserved").notNull().default(0),
    /** 当前运行已成功结算的图片数量；用于重试与幂等扣费 */
    creditsCharged: integer("credits_charged").notNull().default(0),
    /** 用户挑选的作品封面（assets 表 kind="cover" 的资产；封面是增强能力，可空） */
    selectedCoverAssetId: text("selected_cover_asset_id").references((): AnyPgColumn => assets.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
    startedAt: epochColumn("started_at"),
    finishedAt: epochColumn("finished_at"),
  },
  (t) => [
    index("idx_workflow_runs_project").on(t.projectId),
    index("idx_workflow_runs_user").on(t.userId, t.createdAt),
  ],
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
    /** 渠道路由优先级；数值越大越优先，等值时按 sort_order */
    priority: integer("priority").notNull().default(0),
    /** 是否允许普通用户在创作条自行选择该渠道的模型 */
    userModelSelectionEnabled: integer("user_model_selection_enabled").notNull().default(0),
    /** 最近一次从供应商 /models 获取目录的时间 */
    modelsFetchedAt: epochColumn("models_fetched_at"),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** 历史物理列名保留兼容；业务语义为文本/图片通用渠道并发，0 表示不限制 */
    concurrencyMax: integer("image_concurrency_max").notNull().default(0),
    imageEditSupport: integer("image_edit_support").notNull().default(0),
    lastTestOk: integer("last_test_ok"),
    lastTestAt: epochColumn("last_test_at"),
    lastTestDetail: text("last_test_detail"),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [index("idx_channels_type_priority_order").on(t.type, t.priority, t.sortOrder)],
);

/** 渠道模型目录：保存供应商发现的模型及后台选择、优先级、能力和单次价格 */
export const channelModels = pgTable(
  "channel_models",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    providerModelId: text("provider_model_id").notNull(),
    displayName: text("display_name").notNull(),
    /** 0=未选用，1=已选用；新发现模型默认不启用，避免获取目录后直接改变生产路由 */
    enabled: integer("enabled").notNull().default(0),
    isDefault: integer("is_default").notNull().default(0),
    /** 模型在渠道内的优先级；数值越大越优先 */
    priority: integer("priority").notNull().default(0),
    /** 每次调用消耗点数；文本和图片均按次计费，0 可表示管理员配置的免费模型 */
    creditsPerCall: integer("credits_per_call").notNull().default(1),
    /** { textToImage?, imageEditSingle?, imageEditMulti?, maskEdit? } */
    capabilitiesJson: text("capabilities_json").notNull().default("{}"),
    discoveredAt: epochColumn("discovered_at").notNull(),
    lastSeenAt: epochColumn("last_seen_at").notNull(),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_channel_models_provider").on(t.channelId, t.providerModelId),
    index("idx_channel_models_channel_type_priority").on(t.channelId, t.type, t.priority),
  ],
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
    uniqueIndex("uq_users_provider_subject").on(t.authProvider, t.providerSubject),
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

/* ── 计费：套餐 / 订单 / 钱包 / 订阅 / 点数流水 ─────────────────
 * 计价约定：1 点 = 0.1 元；金额一律存「分」（amountCents）；
 * 点数为整数；默认生成一张图片消耗 1 点。 */

/** 订阅套餐（按周期授予点数） */
export const plans = pgTable(
  "plans",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    priceCents: integer("price_cents").notNull(),
    periodDays: integer("period_days").notNull().default(30),
    creditsPerPeriod: integer("credits_per_period").notNull(),
    featuresJson: text("features_json").notNull().default("[]"),
    active: integer("active").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_plans_code").on(t.code)],
);

/** 点数充值包（一次性买断） */
export const creditPackages = pgTable("credit_packages", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  credits: integer("credits").notNull(),
  bonusCredits: integer("bonus_credits").notNull().default(0),
  priceCents: integer("price_cents").notNull(),
  active: integer("active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: epochColumn("updated_at").notNull(),
});

/** 支付订单；type: subscription | credits；channel: alipay | wechat | mock */
export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    /** 商户订单号（唯一，传给支付渠道的 out_trade_no） */
    orderNo: text("order_no").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 管理员调点的操作者；支付订单为空 */
    operatorUserId: text("operator_user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    planId: text("plan_id").references(() => plans.id, { onDelete: "set null" }),
    packageId: text("package_id").references(() => creditPackages.id, { onDelete: "set null" }),
    /** 卡密兑换来源；不建立反向 FK，避免订单与卡密记录互相依赖迁移顺序。 */
    cardId: text("card_id"),
    batchId: text("batch_id"),
    title: text("title").notNull(),
    amountCents: integer("amount_cents").notNull(),
    credits: integer("credits").notNull().default(0),
    channel: text("channel").notNull(),
    status: text("status").notNull().default("pending"),
    qrCode: text("qr_code"),
    channelTradeNo: text("channel_trade_no"),
    failReason: text("fail_reason"),
    paidAt: epochColumn("paid_at"),
    expiresAt: epochColumn("expires_at"),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_orders_no").on(t.orderNo),
    index("idx_orders_user").on(t.userId, t.createdAt),
    index("idx_orders_status").on(t.status),
    index("idx_orders_operator").on(t.operatorUserId, t.createdAt),
    index("idx_orders_card").on(t.cardId, t.createdAt),
    index("idx_orders_batch").on(t.batchId, t.createdAt),
  ],
);

/** 用户点数钱包（一人一行；点数余额与累计口径） */
export const wallets = pgTable(
  "wallets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    balance: integer("balance").notNull().default(0),
    /** 已预留但尚未结算的点数；可用余额 = balance - reservedCredits */
    reservedCredits: integer("reserved_credits").notNull().default(0),
    totalGranted: integer("total_granted").notNull().default(0),
    totalConsumed: integer("total_consumed").notNull().default(0),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_wallets_user").on(t.userId)],
);

/** 订阅关系（一人可有多条历史，active 至多一条由服务层保证） */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"),
    startedAt: epochColumn("started_at").notNull(),
    expiresAt: epochColumn("expires_at").notNull(),
    /** 上次周期发点时间；到期续费顺延 */
    lastGrantAt: epochColumn("last_grant_at").notNull(),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [index("idx_subscriptions_user").on(t.userId, t.status)],
);

/** 点数流水：余额变动的唯一事实来源（审计/对账用） */
export const creditLedger = pgTable(
  "credit_ledger",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 正入负出；余额以 0 兜底时与实际 delta 一致 */
    delta: integer("delta").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    /** starter | purchase | subscription_grant | consume | admin_adjust | refund | card_redeem */
    reason: text("reason").notNull(),
    /** 生成消费所属的 Run；历史流水可为空 */
    runId: text("run_id").references(() => workflowRuns.id, { onDelete: "set null" }),
    /** 卡密兑换来源；与 run_id 二选一或均为空 */
    cardId: text("card_id"),
    refType: text("ref_type"),
    refId: text("ref_id"),
    /** 面向用户展示的任务/作品标题快照；管理员调点使用调整备注 */
    displayTitle: text("display_title"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_credit_ledger_user").on(t.userId, t.createdAt),
    index("idx_credit_ledger_run").on(t.runId),
  ],
);

/** 支付渠道参数（alipay | wechat）；非敏感参数存 config_json，密钥经 AES 加密存 secrets */
export const paymentConfigs = pgTable("payment_configs", {
  id: text("id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  configJson: text("config_json").notNull().default("{}"),
  secretsEncrypted: text("secrets_encrypted"),
  createdAt: createdAt(),
  updatedAt: epochColumn("updated_at").notNull(),
});

/** 运营级系统设置；值使用 JSON，避免把日常开关写入部署环境变量。 */
export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull().default("{}"),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: epochColumn("updated_at").notNull(),
});

/** 卡密批次；benefitJson 保存生成时冻结的权益快照。 */
export const cardBatches = pgTable(
  "card_batches",
  {
    id: text("id").primaryKey(),
    batchNo: text("batch_no").notNull(),
    name: text("name").notNull(),
    benefitType: text("benefit_type").notNull().default("credits"),
    benefitJson: text("benefit_json").notNull().default("{}"),
    quantity: integer("quantity").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: epochColumn("expires_at"),
    source: text("source").notNull().default("admin"),
    /** 外部 API 生成批次所属的 API Key；后台批次为空 */
    apiKeyId: text("api_key_id"),
    externalBatchId: text("external_batch_id"),
    salesChannel: text("sales_channel"),
    remark: text("remark"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_card_batches_no").on(t.batchNo),
    uniqueIndex("uq_card_batches_source_external").on(t.source, t.externalBatchId),
    index("idx_card_batches_status_created").on(t.status, t.createdAt),
    index("idx_card_batches_api_key").on(t.apiKeyId, t.createdAt),
  ],
);

/** 一卡一密；只保存摘要和脱敏信息，不保存可兑换的完整明文。 */
export const redemptionCards = pgTable(
  "redemption_cards",
  {
    id: text("id").primaryKey(),
    batchId: text("batch_id")
      .notNull()
      .references(() => cardBatches.id, { onDelete: "restrict" }),
    codeHash: text("code_hash").notNull(),
    codePrefix: text("code_prefix").notNull(),
    codeLast4: text("code_last4").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: epochColumn("expires_at"),
    redeemedBy: text("redeemed_by").references(() => users.id, { onDelete: "set null" }),
    redeemedAt: epochColumn("redeemed_at"),
    redemptionOrderId: text("redemption_order_id"),
    metadataJson: text("metadata_json"),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_redemption_cards_hash").on(t.codeHash),
    index("idx_redemption_cards_batch_status").on(t.batchId, t.status),
    index("idx_redemption_cards_redeemed_by").on(t.redeemedBy, t.redeemedAt),
  ],
);

/** 卡密兑换成功记录与风控审计。失败尝试不默认写入，避免被攻击者刷爆。 */
export const cardRedemptions = pgTable(
  "card_redemptions",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => redemptionCards.id, { onDelete: "restrict" }),
    batchId: text("batch_id")
      .notNull()
      .references(() => cardBatches.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    orderId: text("order_id").notNull(),
    status: text("status").notNull().default("succeeded"),
    failureCode: text("failure_code"),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("uq_card_redemptions_card").on(t.cardId),
    index("idx_card_redemptions_user_created").on(t.userId, t.createdAt),
    index("idx_card_redemptions_batch_created").on(t.batchId, t.createdAt),
  ],
);

/** 外部销售系统调用凭据；明文只在创建响应中出现一次。 */
export const externalApiKeys = pgTable(
  "external_api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopesJson: text("scopes_json").notNull().default("[\"cards:generate\"]"),
    ipAllowlistJson: text("ip_allowlist_json").notNull().default("[]"),
    rateLimitPerMinute: integer("rate_limit_per_minute").notNull().default(60),
    webhookUrl: text("webhook_url"),
    webhookSecretEncrypted: text("webhook_secret_encrypted"),
    status: text("status").notNull().default("active"),
    lastUsedAt: epochColumn("last_used_at"),
    expiresAt: epochColumn("expires_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_external_api_keys_hash").on(t.keyHash),
    index("idx_external_api_keys_status").on(t.status, t.createdAt),
  ],
);

/** 外部接口幂等记录；响应短期加密保存，用于网络重试时原样重放明文卡密。 */
export const apiIdempotencyRecords = pgTable(
  "api_idempotency_records",
  {
    id: text("id").primaryKey(),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => externalApiKeys.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    responseEncrypted: text("response_encrypted").notNull(),
    expiresAt: epochColumn("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("uq_api_idempotency_key").on(t.apiKeyId, t.idempotencyKey),
    index("idx_api_idempotency_expiry").on(t.expiresAt),
  ],
);

/** 兑换成功后的外部通知投递队列；当前单进程用定时器处理，后续可迁移 Redis。 */
export const cardWebhookDeliveries = pgTable(
  "card_webhook_deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => externalApiKeys.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    resourceId: text("resource_id").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    secretEncrypted: text("secret_encrypted"),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: epochColumn("next_attempt_at").notNull(),
    lastError: text("last_error"),
    deliveredAt: epochColumn("delivered_at"),
    createdAt: createdAt(),
    updatedAt: epochColumn("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_card_webhook_event").on(t.apiKeyId, t.eventId),
    index("idx_card_webhook_pending").on(t.status, t.nextAttemptAt),
  ],
);

/** 卡密管理动作审计。 */
export const cardAuditLogs = pgTable(
  "card_audit_logs",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    batchId: text("batch_id"),
    cardId: text("card_id"),
    apiKeyId: text("api_key_id"),
    detailJson: text("detail_json"),
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
  },
  (t) => [index("idx_card_audit_created").on(t.createdAt), index("idx_card_audit_batch").on(t.batchId, t.createdAt)],
);

export type Channel = typeof channels.$inferSelect;
export type ChannelModel = typeof channelModels.$inferSelect;
export type BrandKit = typeof brandKits.$inferSelect;
export type Revision = typeof revisions.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type CreditPackage = typeof creditPackages.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Wallet = typeof wallets.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type CreditLedgerRow = typeof creditLedger.$inferSelect;
export type PaymentConfig = typeof paymentConfigs.$inferSelect;
export type SystemSetting = typeof systemSettings.$inferSelect;
export type CardBatch = typeof cardBatches.$inferSelect;
export type RedemptionCard = typeof redemptionCards.$inferSelect;
export type CardRedemption = typeof cardRedemptions.$inferSelect;
export type ExternalApiKey = typeof externalApiKeys.$inferSelect;
export type ApiIdempotencyRecord = typeof apiIdempotencyRecords.$inferSelect;
export type CardWebhookDelivery = typeof cardWebhookDeliveries.$inferSelect;
export type CardAuditLog = typeof cardAuditLogs.$inferSelect;

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
