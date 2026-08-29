import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

export interface DatabaseOptions {
  /** SQLite 文件路径；:memory: 用于测试 */
  sqlitePath: string;
  /** drizzle 迁移文件夹（含 meta/_journal.json） */
  migrationsFolder?: string;
}

export interface OpenDatabase {
  db: Db;
  raw: Database.Database;
  close(): void;
}

/**
 * 打开 SQLite 并确保 WAL、外键与 busy_timeout 生效。
 * 目录不存在时自动创建；随后执行版本控制中的迁移。
 */
export function openDatabase(options: DatabaseOptions): OpenDatabase {
  if (options.sqlitePath !== ":memory:") {
    fs.mkdirSync(path.dirname(options.sqlitePath), { recursive: true });
  }
  const raw = new Database(options.sqlitePath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");

  const db = drizzle(raw, { schema });

  if (options.migrationsFolder) {
    migrate(db, { migrationsFolder: options.migrationsFolder });
  }

  return {
    db,
    raw,
    close() {
      raw.pragma("wal_checkpoint(TRUNCATE)");
      raw.close();
    },
  };
}
