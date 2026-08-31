/**
 * 迭代 4-4.1：SQLite 导出数据 → PostgreSQL 导入工具（阶段 3）。
 * 读取 pg:export 产出的 JSONL + manifest，逐表导入 DATABASE_URL 指向的 PG，
 * 校验行数与 SHA-256 一致后报告结果。列名与旧 SQLite 一致（snake_case），新列留默认值。
 * 用法：pnpm pg:import [--dir pg-dump] [--truncate]
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { loadDotEnv } from "./lib/env.js";
import { PG_MIGRATION_TABLES } from "./lib/pg-migration-tables.js";

loadDotEnv();

const root = path.resolve(import.meta.dirname, "..");
const dumpDir = path.resolve(
  process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : path.join(root, "pg-dump"),
);
const truncate = process.argv.includes("--truncate");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("缺少 DATABASE_URL（指向目标 PostgreSQL）");
  process.exit(1);
}

interface ManifestEntry {
  table: string;
  rows: number;
  sha256: string;
  file: string;
}

interface Manifest {
  formatVersion?: number;
  exportedAt: string;
  tables: ManifestEntry[];
  skippedTables?: string[];
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(dumpDir, "manifest.json"), "utf8"),
) as Manifest;

const allowedTables = new Set<string>(PG_MIGRATION_TABLES);
for (const entry of manifest.tables) {
  if (!allowedTables.has(entry.table)) throw new Error(`manifest 含未知表：${entry.table}`);
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  if (truncate) {
    // 仅在显式 --truncate 时执行；CASCADE 覆盖当前账号、计费、支付和工作流全表。
    await sql.unsafe(`TRUNCATE TABLE ${PG_MIGRATION_TABLES.join(", ")} CASCADE`);
    console.log(`已清空目标表（--truncate，${PG_MIGRATION_TABLES.length} 张表）`);
  }

  for (const entry of manifest.tables) {
    if (!/^[a-z0-9_]+$/.test(entry.table) || entry.file !== path.basename(entry.file)) {
      throw new Error(`非法迁移清单标识符：${entry.table} / ${entry.file}`);
    }
    const filePath = path.join(dumpDir, entry.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`  跳过 ${entry.table}：${entry.file} 不存在`);
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.length > 0 ? content.split("\n").filter((line) => line.length > 0) : [];
    const sha = createHash("sha256").update(lines.join("\n")).digest("hex");
    if (sha !== entry.sha256 || lines.length !== entry.rows) {
      throw new Error(`校验和不一致：${entry.table}（文件 ${sha}/${lines.length} vs manifest ${entry.sha256}/${entry.rows}）`);
    }

    let inserted = 0;
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      const columns = Object.keys(row);
      if (columns.length === 0) continue;
      // 列名/表名来自受控的导出产物，仍做白名单校验后拼 SQL
      if (!/^[a-z0-9_]+$/.test(entry.table) || columns.some((column) => !/^[a-z0-9_]+$/.test(column))) {
        throw new Error(`非法标识符：${entry.table} / ${columns.join(",")}`);
      }
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      const values = columns.map((column) => row[column] ?? null);
      await sql.unsafe(`insert into ${entry.table} (${columns.join(", ")}) values (${placeholders}) on conflict do nothing`, values);
      inserted += 1;
    }
    const countRows = (await sql.unsafe(`select count(*)::bigint as count from ${entry.table}`)) as Array<{ count: string | number }>;
    const targetCount = Number(countRows[0]?.count ?? 0);
    if (truncate && targetCount !== entry.rows) {
      throw new Error(`导入行数不一致：${entry.table}（目标 ${targetCount} / 清单 ${entry.rows}）`);
    }
    console.log(`  ${entry.table}: 读取 ${entry.rows} 行，写入 ${inserted} 行，目标现有 ${targetCount} 行（校验和一致）`);
  }
  if (manifest.skippedTables?.length) {
    console.log(`\n源 SQLite 缺少并跳过：${manifest.skippedTables.join(", ")}`);
  }
  console.log(`\n导入完成：${new URL(databaseUrl).host}/${new URL(databaseUrl).pathname.slice(1)}`);
} finally {
  await sql.end({ timeout: 5 });
}
