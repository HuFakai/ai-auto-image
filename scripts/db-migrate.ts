/** 数据库迁移：创建/更新 SQLite 表结构（可在 Docker 外手动执行） */
import path from "node:path";
import { openDatabase } from "@aai/storage";
import { loadDotEnv } from "./lib/env";

loadDotEnv();

const root = path.resolve(import.meta.dirname ?? process.cwd(), "..");
const dataDir = process.env.DATA_DIR ?? path.join(root, "data");
const sqlitePath = process.env.SQLITE_PATH ?? path.join(dataDir, "db", "app.db");
const migrationsDir =
  process.env.SQLITE_MIGRATIONS_DIR ?? path.join(root, "packages", "storage", "drizzle");

const db = openDatabase({ sqlitePath, migrationsFolder: migrationsDir });
const tables = db.raw
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as Array<{ name: string }>;
console.log(`SQLite ready: ${sqlitePath}`);
console.log(`tables: ${tables.map((t) => t.name).join(", ")}`);
db.close();
