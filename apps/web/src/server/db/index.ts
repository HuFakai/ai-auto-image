import { existsSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { runMigrations } from "./migrations";

export type Db = BetterSQLite3Database<typeof schema>;

let _db: Db | null = null;
let _sqlite: Database.Database | null = null;

export function dataDir(): string {
  const dir = process.env.DATA_DIR ?? "./data";
  mkdirSync(`${dir}/assets`, { recursive: true });
  mkdirSync(`${dir}/exports`, { recursive: true });
  return dir;
}

export function assetRoot(): string {
  return `${dataDir()}/assets`;
}

export function exportRoot(): string {
  return `${dataDir()}/exports`;
}

export function getDb(): Db {
  if (_db) return _db;
  const path = process.env.SQLITE_PATH ?? `${dataDir()}/app.db`;
  mkdirSync(path.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  _sqlite = new Database(path);
  // WAL + busy_timeout + FK per master plan 5.3
  _sqlite.pragma("journal_mode = WAL");
  _sqlite.pragma("busy_timeout = 5000");
  _sqlite.pragma("foreign_keys = ON");
  runMigrations(_sqlite);
  _db = drizzle(_sqlite, { schema });
  return _db;
}

export function getSqlite(): Database.Database {
  getDb();
  return _sqlite!;
}

/** Safety guard used by tests and startup checks. */
export function isWALEnabled(): boolean {
  const mode = _sqlite?.pragma("journal_mode", { simple: true }) as unknown as string;
  return mode === "wal";
}
