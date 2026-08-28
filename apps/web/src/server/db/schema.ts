import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = () => new Date().toISOString();

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  monthlyBudgetCny: integer("monthly_budget_cny"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  name: text("name").notNull(),
  email: text("email"),
  /** owner|admin|editor|reviewer|publisher|viewer */
  role: text("role").notNull().default("owner"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().default("ws_default"),
    title: text("title").notNull().default("未命名项目"),
    /** knowledge-card|article-breakdown|book-recommendation|product-promo|science-comic */
    recipeId: text("recipe_id").notNull(),
    platform: text("platform").notNull(),
    aspectRatio: text("aspect_ratio").notNull(),
    status: text("status").notNull().default("DRAFT"),
    textRenderingMode: text("text_rendering_mode").notNull().default("native"),
    themeId: text("theme_id").notNull().default("minimal-knowledge"),
    brandKitId: text("brand_kit_id"),
    inputText: text("input_text").notNull().default(""),
    inputKind: text("input_kind").notNull().default("topic"),
    brief: text("brief"),
    storyboard: text("storyboard"),
    selectedTitle: text("selected_title"),
    imageConcurrency: integer("image_concurrency").notNull().default(1),
    coverAssetId: text("cover_asset_id"),
    productData: text("product_data"),
    bookData: text("book_data"),
    archived: integer("archived").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => [index("projects_status_idx").on(t.status), index("projects_ws_idx").on(t.workspaceId)]
);

export const brandKits = sqliteTable("brand_kits", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default("ws_default"),
  name: text("name").notNull(),
  data: text("data").notNull(),
  builtin: integer("builtin").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    status: text("status").notNull().default("PLANNING"),
    /** requested / effective concurrency snapshot */
    concurrencyRequested: integer("concurrency_requested").notNull().default(1),
    concurrencyEffective: integer("concurrency_effective").notNull().default(1),
    textRenderingMode: text("text_rendering_mode").notNull().default("native"),
    promptVersion: text("prompt_version"),
    error: text("error"),
    estimatedCostCny: integer("estimated_cost_cny").default(0),
    actualCostCny: integer("actual_cost_cny").default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
    finishedAt: text("finished_at"),
  },
  (t) => [index("runs_project_idx").on(t.projectId)]
);

export const nodeRuns = sqliteTable(
  "node_runs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    nodeKey: text("node_key").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("PENDING"),
    attempt: integer("attempt").notNull().default(0),
    inputRef: text("input_ref"),
    outputRef: text("output_ref"),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    errorType: text("error_type"),
    errorSummary: text("error_summary"),
  },
  (t) => [uniqueIndex("node_runs_run_node_idx").on(t.runId, t.nodeKey)]
);

export const promptVersions = sqliteTable("prompt_versions", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  version: text("version").notNull(),
  template: text("template").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id"),
    runId: text("run_id"),
    /** generated|native|composite|export|upload|reference */
    kind: text("kind").notNull(),
    slideIndex: integer("slide_index"),
    path: text("path").notNull(),
    url: text("url"),
    mimeType: text("mime_type").notNull().default("image/jpeg"),
    width: integer("width").notNull().default(0),
    height: integer("height").notNull().default(0),
    bytes: integer("bytes").notNull().default(0),
    sha256: text("sha256"),
    meta: text("meta"),
    deleted: integer("deleted").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("assets_project_idx").on(t.projectId), index("assets_kind_idx").on(t.kind)]
);

export const assetRelations = sqliteTable("asset_relations", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull(),
  relatedAssetId: text("related_asset_id").notNull(),
  /** reference|derived|replaces|version_of */
  relation: text("relation").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const providerUsages = sqliteTable(
  "provider_usages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().default("ws_default"),
    runId: text("run_id"),
    nodeId: text("node_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    kind: text("kind").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    imageCount: integer("image_count").notNull().default(0),
    costCny: integer("cost_cny").notNull().default(0),
    costUsd: integer("cost_usd").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("usages_run_idx").on(t.runId), index("usages_ws_idx").on(t.workspaceId)]
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: text("payload").notNull().default("{}"),
    /** queued|running|succeeded|failed|cancelled */
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(1),
    runId: text("run_id"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [index("jobs_status_idx").on(t.status)]
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    slideIndex: integer("slide_index").notNull(),
    /** copy|theme|image_prompt|reorder|regenerate */
    kind: text("kind").notNull(),
    patch: text("patch").notNull().default("{}"),
    requiresAiCall: integer("requires_ai_call").notNull().default(0),
    previousStoryboard: text("previous_storyboard"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("revisions_project_idx").on(t.projectId)]
);

export const qualityReports = sqliteTable("quality_reports", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  projectId: text("project_id").notNull(),
  mode: text("mode").notNull(),
  passed: integer("passed").notNull().default(1),
  report: text("report").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

// ---- Phase 2: comics ----

export const characters = sqliteTable(
  "characters",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    data: text("data").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("characters_project_idx").on(t.projectId)]
);

export const scenes = sqliteTable(
  "scenes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    name: text("name").notNull(),
    data: text("data").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [index("scenes_project_idx").on(t.projectId)]
);

// ---- Phase 3: platform publishing & workflow defs ----

export const platformAccounts = sqliteTable("platform_accounts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default("ws_default"),
  platform: text("platform").notNull(),
  alias: text("alias").notNull(),
  credential: text("credential"),
  enabled: integer("enabled").notNull().default(1),
  lastCheckedAt: text("last_checked_at"),
  lastStatus: text("last_status"),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const publishJobs = sqliteTable(
  "publish_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    platform: text("platform").notNull(),
    accountId: text("account_id").notNull(),
    /** draft|publish */
    scope: text("scope").notNull().default("draft"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    externalId: text("external_id"),
    authorization: text("authorization").notNull(),
    scheduledAt: text("scheduled_at"),
    input: text("input").notNull(),
    result: text("result"),
    error: text("error"),
    createdAt: text("created_at").notNull().$defaultFn(now),
    updatedAt: text("updated_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("publish_jobs_idem_idx").on(t.idempotencyKey), index("publish_jobs_project_idx").on(t.projectId)]
);

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  projectId: text("project_id").notNull(),
  /** direction|title|final|publish */
  kind: text("kind").notNull(),
  status: text("status").notNull().default("pending"),
  requestedBy: text("requested_by"),
  decidedBy: text("decided_by"),
  note: text("note"),
  createdAt: text("created_at").notNull().$defaultFn(now),
  decidedAt: text("decided_at"),
});

export const workflowDefinitions = sqliteTable("workflow_definitions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default("ws_default"),
  name: text("name").notNull(),
  version: integer("version").notNull().default(1),
  definition: text("definition").notNull(),
  immutable: integer("immutable").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

// ---- Phase 4: open platform ----

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().default("ws_default"),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    scopes: text("scopes").notNull().default("[\"generate\",\"export\"]"),
    rateLimitPerMin: integer("rate_limit_per_min").notNull().default(30),
    revoked: integer("revoked").notNull().default(0),
    lastUsedAt: text("last_used_at"),
    createdAt: text("created_at").notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash)]
);

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().default("ws_default"),
  url: text("url").notNull(),
  events: text("events").notNull().default("[]"),
  secret: text("secret").notNull(),
  enabled: integer("enabled").notNull().default(1),
  createdAt: text("created_at").notNull().$defaultFn(now),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().$defaultFn(now),
});
