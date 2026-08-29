/** 极简 .env 加载器：已存在的环境变量优先，不覆盖 */
import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(rootDir?: string): void {
  const candidates = [
    process.env.AAI_ENV_FILE,
    rootDir ? path.join(rootDir, ".env") : undefined,
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "../../.env"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const content = fs.readFileSync(candidate, "utf8");
    for (const line of content.split("\n")) {
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
