type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? "info";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

/** 结构化 JSON 日志：一行一条，字段直接可查询；禁止打印密钥与完整请求头 */
const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|authorization|cookie|api[_-]?key|(^|[^a-z])key([^a-z]|$)/i;

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry = { ts: new Date().toISOString(), level, msg: message, ...fields };
  const line = JSON.stringify(entry, (_key, value) =>
    typeof value === "string" && SENSITIVE_KEY_PATTERN.test(_key)
      ? "[REDACTED]"
      : value,
  );
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
};
