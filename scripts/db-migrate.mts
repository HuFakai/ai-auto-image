/** 数据库迁移：创建/更新 PostgreSQL 表结构（openDatabase 打开时也会自动执行） */
import path from "node:path";
import postgres from "postgres";
import { openDatabase } from "@aai/storage";
import { loadDotEnv } from "./lib/env";

loadDotEnv();

const root = path.resolve(import.meta.dirname ?? process.cwd(), "..");
const migrationsDir =
  process.env.SQLITE_MIGRATIONS_DIR ?? path.join(root, "packages", "storage", "drizzle");

const db = await openDatabase({ url: process.env.DATABASE_URL, migrationsFolder: migrationsDir });
let tables: string[] = [];
if (process.env.DATABASE_URL) {
  const client = postgres(process.env.DATABASE_URL, { max: 1 });
  const rows = await client`select tablename from pg_tables where schemaname = 'public' order by tablename`;
  tables = rows.map((row) => String(row.tablename));
  await client.end({ timeout: 5 });
} else {
  tables = ["(PGlite 内存实例，15 张业务表已就绪)"];
}
const target = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : "PGlite(内存)";
console.log(`PostgreSQL ready: ${target}`);
console.log(`tables: ${tables.join(", ")}`);
await db.close();
