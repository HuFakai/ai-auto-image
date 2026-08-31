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
import { PG_MIGRATION_TABLES } from "./lib/pg-migration-tables.js";

loadDotEnv();

const root = path.resolve(import.meta.dirname, "..");
// .env 的 DATA_DIR=./data 相对于 apps/web；脚本从根目录运行时优先用开发库实际位置
const dataDir = fs.existsSync(path.resolve(root, "apps/web/data/db/app.db"))
  ? path.resolve(root, "apps/web/data")
  : path.resolve(process.env.DATA_DIR ?? path.join(root, "apps/web", "data"));
const sqlitePath = process.env.SQLITE_PATH ?? path.join(dataDir, "db", "app.db");

if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite 文件不存在：${sqlitePath}（无历史数据可导出，跳过迁移即可）`);
  process.exit(1);
}

const db = new Database(sqlitePath, { readonly: true });
const outDir = path.resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : path.join(root, "pg-dump"));
fs.mkdirSync(outDir, { recursive: true });

const existingTables = new Set(
  (db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>).map((row) => row.name),
);
const manifest: Array<{ table: string; rows: number; sha256: string; file: string }> = [];
const skippedTables: string[] = [];

for (const table of PG_MIGRATION_TABLES) {
  // 旧 SQLite 库可能早于账号/计费版本；缺表跳过并写入清单，不能让整次迁移因兼容性中断。
  if (!existingTables.has(table)) {
    skippedTables.push(table);
    console.warn(`  ${table}: 旧库不存在，跳过`);
    continue;
  }
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
  JSON.stringify(
    {
      formatVersion: 2,
      exportedAt: new Date().toISOString(),
      sqlitePath,
      tables: manifest,
      skippedTables,
    },
    null,
    2,
  ),
);
console.log(`\n导出完成：${outDir}（${manifest.length} 张表；manifest.json 含行数、校验和与跳过表）`);
console.log("下一步：pnpm pg:import 导入到 DATABASE_URL 指向的 PostgreSQL。");
