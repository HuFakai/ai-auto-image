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

const manifest = JSON.parse(
  fs.readFileSync(path.join(dumpDir, "manifest.json"), "utf8"),
) as { exportedAt: string; tables: ManifestEntry[] };

const sql = postgres(databaseUrl, { max: 1 });
try {
  if (truncate) {
    // 外键依赖顺序：先子表后父表；TRUNCATE ... CASCADE 一次到位
    await sql.unsafe(`TRUNCATE TABLE projects, workflow_runs, node_runs, prompt_versions, assets,
      asset_relations, provider_attempts, provider_usages, channels, brand_kits, revisions, jobs, job_events CASCADE`);
    console.log("已清空目标表（--truncate）");
  }

  for (const entry of manifest.tables) {
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
      await sql.unsafe(
        `insert into ${entry.table} (${columns.join(", ")}) values (${placeholders}) on conflict (id) do nothing`,
        values,
      );
      inserted += 1;
    }
    console.log(`  ${entry.table}: 导入 ${inserted}/${entry.rows} 行（校验和一致）`);
  }
  console.log(`\n导入完成：${new URL(databaseUrl).host}/${new URL(databaseUrl).pathname.slice(1)}`);
} finally {
  await sql.end({ timeout: 5 });
}
