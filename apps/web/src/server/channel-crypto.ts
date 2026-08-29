import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * 渠道密钥加密存储：AES-256-GCM。
 * 主密钥来源：APP_SECRET 环境变量（任意字符串，scrypt 派生）；
 * 未设置时在 DATA_DIR/.secret 生成并持久化随机密钥。
 */
export function getEncryptionKey(dataDir: string): Buffer {
  const secret = process.env.APP_SECRET;
  if (secret && secret.length > 0) {
    return scryptSync(secret, "aai-channel-key", 32);
  }
  const secretFile = path.join(dataDir, ".secret");
  let value = process.env.APP_SECRET;
  if (!value) {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(secretFile)) {
      value = fs.readFileSync(secretFile, "utf8").trim();
    } else {
      value = randomBytes(32).toString("hex");
      fs.writeFileSync(secretFile, value, { mode: 0o600 });
    }
  }
  return scryptSync(value, "aai-channel-key", 32);
}

export function encryptApiKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptApiKey(key: Buffer, stored: string): string {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("corrupted api key payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

/** 脱敏提示：只展示末 4 位 */
export function apiKeyHint(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `••••${plaintext.slice(-4)}`;
}
