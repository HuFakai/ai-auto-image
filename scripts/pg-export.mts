/**
 * 迭代 4-4.1：旧 SQLite → PostgreSQL 迁移导出工具（阶段 3）。
 * 直接读 SQLite 文件（不经 storage 层——存储层已切换 PG 方言），导出为 JSONL + 校验和清单。
 * 导入：pnpm pg:import（scripts/pg-import.mts）。
 * 用法：pnpm pg:export [--out pg-dump]
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { loadDotEnv } from "./lib/env.js";

loadDotEnv();

const root = path.resolve(import.meta.dirname, "..");
// .env 的 DATA_DIR=./data 相对于 apps/web；脚本从根目录运行时优先用开发库实际位置
const dataDir = fs.existsSync(path.resolve(root, "apps/web/data/db/app.db"))
  ? path.resolve(root, "apps/web/data")
  : path.resolve(process.env.DATA_DIR ?? path.join(root, "apps/web", "data"));
const sqlitePath = process.env.SQLITE_PATH ?? path.join(dataDir, "db", "app.db");

const TABLES = [
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
  "jobs",
  "job_events",
] as const;

if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite 文件不存在：${sqlitePath}（无历史数据可导出，跳过迁移即可）`);
  process.exit(1);
}

const db = new Database(sqlitePath, { readonly: true });
const outDir = path.resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : path.join(root, "pg-dump"));
fs.mkdirSync(outDir, { recursive: true });

const manifest: Array<{ table: string; rows: number; sha256: string; file: string }> = [];

for (const table of TABLES) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  const file = `${table}.jsonl`;
  const lines = rows.map((row) => JSON.stringify(row));
  fs.writeFileSync(path.join(outDir, file), lines.join("\n"));
  const sha = createHash("sha256").update(lines.join("\n")).digest("hex");
  manifest.push({ table, rows: rows.length, sha256: sha, file });
  console.log(`  ${table}: ${rows.length} 行`);
}
db.close();

fs.writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify({ exportedAt: new Date().toISOString(), sqlitePath, tables: manifest }, null, 2),
);
console.log(`\n导出完成：${outDir}（manifest.json 含每表行数与校验和）`);
console.log("下一步：pnpm pg:import 导入到 DATABASE_URL 指向的 PostgreSQL。");
