import type Database from "better-sqlite3";

/**
 * Embedded, idempotent migrations. Each entry runs once inside a transaction;
 * applied names are tracked in schema_migrations.
 */
export const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: "0001_init.sql",
    sql: `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  monthly_budget_cny INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  title TEXT NOT NULL DEFAULT '未命名项目',
  recipe_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  text_rendering_mode TEXT NOT NULL DEFAULT 'native',
  theme_id TEXT NOT NULL DEFAULT 'minimal-knowledge',
  brand_kit_id TEXT,
  input_text TEXT NOT NULL DEFAULT '',
  input_kind TEXT NOT NULL DEFAULT 'topic',
  brief TEXT,
  storyboard TEXT,
  selected_title TEXT,
  image_concurrency INTEGER NOT NULL DEFAULT 1,
  cover_asset_id TEXT,
  product_data TEXT,
  book_data TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS projects_status_idx ON projects(status);
CREATE INDEX IF NOT EXISTS projects_ws_idx ON projects(workspace_id);
CREATE TABLE IF NOT EXISTS brand_kits (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLANNING',
  concurrency_requested INTEGER NOT NULL DEFAULT 1,
  concurrency_effective INTEGER NOT NULL DEFAULT 1,
  text_rendering_mode TEXT NOT NULL DEFAULT 'native',
  prompt_version TEXT,
  error TEXT,
  estimated_cost_cny INTEGER DEFAULT 0,
  actual_cost_cny INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_project_idx ON workflow_runs(project_id);
CREATE TABLE IF NOT EXISTS node_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempt INTEGER NOT NULL DEFAULT 0,
  input_ref TEXT,
  output_ref TEXT,
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_type TEXT,
  error_summary TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS node_runs_run_node_idx ON node_runs(run_id, node_key);
CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  version TEXT NOT NULL,
  template TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  slide_index INTEGER,
  path TEXT NOT NULL,
  url TEXT,
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  meta TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS assets_project_idx ON assets(project_id);
CREATE INDEX IF NOT EXISTS assets_kind_idx ON assets(kind);
CREATE TABLE IF NOT EXISTS asset_relations (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  related_asset_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS provider_usages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  run_id TEXT,
  node_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  image_count INTEGER NOT NULL DEFAULT 0,
  cost_cny INTEGER NOT NULL DEFAULT 0,
  cost_usd INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS usages_run_idx ON provider_usages(run_id);
CREATE INDEX IF NOT EXISTS usages_ws_idx ON provider_usages(workspace_id);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  run_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  slide_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  patch TEXT NOT NULL DEFAULT '{}',
  requires_ai_call INTEGER NOT NULL DEFAULT 0,
  previous_storyboard TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS revisions_project_idx ON revisions(project_id);
CREATE TABLE IF NOT EXISTS quality_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  project_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 1,
  report TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS characters_project_idx ON characters(project_id);
CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS scenes_project_idx ON scenes(project_id);
CREATE TABLE IF NOT EXISTS platform_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  platform TEXT NOT NULL,
  alias TEXT NOT NULL,
  credential TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS publish_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'draft',
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  external_id TEXT,
  authorization TEXT NOT NULL,
  scheduled_at TEXT,
  input TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS publish_jobs_idem_idx ON publish_jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS publish_jobs_project_idx ON publish_jobs(project_id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT,
  decided_by TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  definition TEXT NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["generate","export"]',
  rate_limit_per_min INTEGER NOT NULL DEFAULT 30,
  revoked INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'ws_default',
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO workspaces (id, name) VALUES ('ws_default', '个人工作区');
INSERT OR IGNORE INTO users (id, workspace_id, name, role) VALUES ('user_default', 'ws_default', '创建者', 'owner');
`,
  },
];

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const applied = new Set(
    (sqlite.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map((r) => r.name)
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    const tx = sqlite.transaction(() => {
      sqlite.exec(m.sql);
      sqlite
        .prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(m.name, new Date().toISOString());
    });
    tx();
  }
}
