import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePgLite, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePgLite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePgJs, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate as migratePgJs } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * 数据库层（PostgreSQL 方言）：
 * - openPostgresDatabase：postgres.js 连接远程/生产 PG（DATABASE_URL）
 * - openPgliteDatabase：进程内 PGlite（WASM PG），测试与零配置本地运行
 * Repo 层对两者透明：同一套 pg schema 与 SQL。
 */
export type Db = PostgresJsDatabase<typeof schema> | PgliteDatabase<typeof schema>;

/** Repo 内部统一按 postgres.js 形状调用；两种驱动运行时行为一致（await 返回行数组） */
export type DbClient = PostgresJsDatabase<typeof schema>;

export interface DatabaseOptions {
  /** PG 连接串；未提供时使用进程内 PGlite */
  url?: string;
  /** drizzle 迁移文件夹（含 meta/_journal.json） */
  migrationsFolder?: string;
  /** PGlite 持久化目录（默认内存） */
  dataDir?: string;
}

export interface OpenDatabase {
  db: Db;
  close(): Promise<void>;
}

async function runMigrations(
  db: Db,
  migrationsFolder: string,
  driver: "pglite" | "pgjs",
): Promise<void> {
  if (driver === "pglite") {
    await migratePgLite(db as PgliteDatabase<typeof schema>, { migrationsFolder });
    return;
  }
  await migratePgJs(db as PostgresJsDatabase<typeof schema>, { migrationsFolder });
}

/** 远程/生产 PostgreSQL（postgres.js 驱动） */
export async function openPostgresDatabase(options: DatabaseOptions): Promise<OpenDatabase> {
  if (!options.url) throw new Error("openPostgresDatabase requires url");
  const client = postgres(options.url, {
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const db = drizzlePgJs(client, { schema });
  if (options.migrationsFolder) {
    await runMigrations(db, options.migrationsFolder, "pgjs");
  }
  return {
    db,
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

/** 进程内 PGlite（WASM PostgreSQL）：测试与零配置本地运行 */
export async function openPgliteDatabase(options: DatabaseOptions): Promise<OpenDatabase> {
  const client = options.dataDir ? new PGlite(options.dataDir) : new PGlite();
  const db = drizzlePgLite(client, { schema });
  if (options.migrationsFolder) {
    await runMigrations(db, options.migrationsFolder, "pglite");
  }
  return {
    db,
    async close() {
      await client.close();
    },
  };
}

/**
 * 统一入口：有 DATABASE_URL 用 postgres.js，否则回退 PGlite。
 * 两条路径都会自动执行迁移（需要 migrationsFolder）。
 */
export async function openDatabase(options: DatabaseOptions): Promise<OpenDatabase> {
  if (options.url) return openPostgresDatabase(options);
  return openPgliteDatabase(options);
}
