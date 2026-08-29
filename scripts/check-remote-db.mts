/** 开发调试用：验证本机 → 服务器 PG / Redis 远程连通（不进 git 的 .env 提供凭据） */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

function loadEnv(): void {
  const candidates = [path.join(process.cwd(), ".env"), path.join(process.cwd(), "../../.env")];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return;
  }
}

async function checkPostgres(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { connect_timeout: 8, max: 1 });
  try {
    const [row] = await sql`select version() as v, current_database() as db`;
    console.log("[PG] OK", { db: row.db, version: row.v.split(",")[0] });
    const tables = await sql`select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
    console.log("[PG] public tables:", tables[0].n);
  } finally {
    await sql.end({ timeout: 3 });
  }
}

/** 手写 RESP 发 AUTH + PING，避免为本脚本引入 ioredis */
function checkRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL not set");
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      timeout: 8000,
    });
    const password = decodeURIComponent(parsed.password);
    let stage = 0;
    let buffer = "";
    socket.on("connect", () => {
      socket.write(`AUTH ${password}\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (stage === 0 && buffer.includes("+OK")) {
        stage = 1;
        socket.write("PING\r\n");
        return;
      }
      if (stage === 1 && buffer.includes("PONG")) {
        console.log("[Redis] OK (AUTH + PONG)");
        socket.end();
        resolve();
      }
    });
    socket.on("timeout", () => reject(new Error("[Redis] timeout")));
    socket.on("error", reject);
  });
}

loadEnv();
try {
  await checkPostgres();
} catch (error) {
  console.error("[PG] FAIL:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
try {
  await checkRedis();
} catch (error) {
  console.error("[Redis] FAIL:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
