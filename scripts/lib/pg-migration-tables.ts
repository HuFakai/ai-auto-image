/**
 * 当前 PostgreSQL schema 的迁移表白名单。
 * 顺序按“父表在前、子表在后”排列，供旧 SQLite 导出和导入共同使用。
 */
export const PG_MIGRATION_TABLES = [
  "users",
  "plans",
  "credit_packages",
  "projects",
  "workflow_runs",
  "node_runs",
  "prompt_versions",
  "assets",
  "asset_relations",
  "provider_attempts",
  "provider_usages",
  "channels",
  "brand_kits",
  "revisions",
  "sessions",
  "orders",
  "wallets",
  "subscriptions",
  "credit_ledger",
  "payment_configs",
  "jobs",
  "job_events",
] as const;

export type PgMigrationTable = (typeof PG_MIGRATION_TABLES)[number];
