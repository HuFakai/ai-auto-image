import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@aai/storage";
import { getRuntime } from "./runtime";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

export const SESSION_COOKIE = "aai_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/* ── 密码哈希（scrypt，格式 scrypt$N$r$p$saltB64$hashB64；零原生依赖） ── */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* ── 会话：随机 token 存 cookie，服务端只存 SHA-256 摘要（可吊销） ── */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export interface SessionUser {
  id: string;
  username: string;
  role: "admin" | "user";
  authProvider: string;
}

function toSessionUser(user: User): SessionUser {
  return { id: user.id, username: user.username, role: user.role as "admin" | "user", authProvider: user.authProvider };
}

/** 签发新会话（返回写入 cookie 的明文 token） */
export async function issueSession(userId: string, authProvider = "password"): Promise<string> {
  const runtime = await getRuntime();
  const token = randomBytes(32).toString("base64url");
  await runtime.sessionRepo.create({
    userId,
    tokenHash: sha256(token),
    authProvider,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export function sessionCookieOptions(maxAgeSeconds = SESSION_TTL_MS / 1000) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** 读取当前登录用户（无会话/过期/被禁用 → null）；Server Component 与 Route Handler 通用 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const runtime = await getRuntime();
  const session = await runtime.sessionRepo.findValidByTokenHash(sha256(token));
  if (!session) return null;
  try {
    const user = await runtime.userRepo.require(session.userId);
    if (user.status !== "active") return null;
    return toSessionUser(user);
  } catch {
    return null;
  }
}

/** Server Component 守卫：未登录跳转 /login */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Route Handler 守卫：返回 null 时调用方统一回 401 */
export async function requireApiUser(): Promise<SessionUser | null> {
  return getCurrentUser();
}

/** 管理员守卫（渠道/Brand Kit/设置类） */
export async function requireAdmin(): Promise<SessionUser | null> {
  const user = await getCurrentUser();
  return user?.role === "admin" ? user : null;
}

export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return;
  const runtime = await getRuntime();
  await runtime.sessionRepo.deleteByTokenHash(sha256(token));
}

/* ── 注册策略：首个用户自动 admin；此后需 REGISTER_ENABLED + 邀请码 ── */

export interface RegisterPolicyResult {
  allowed: boolean;
  reason?: string;
  role: "admin" | "user";
}

export async function registerPolicy(inviteCode?: string): Promise<RegisterPolicyResult> {
  const runtime = await getRuntime();
  if ((await runtime.userRepo.count()) === 0) {
    return { allowed: true, role: "admin" }; // 首个注册用户 = 管理员
  }
  if (process.env.REGISTER_ENABLED !== "1") {
    return { allowed: false, reason: "注册未开放", role: "user" };
  }
  const expected = process.env.REGISTER_INVITE_CODE;
  if (expected && inviteCode !== expected) {
    return { allowed: false, reason: "邀请码错误", role: "user" };
  }
  return { allowed: true, role: "user" };
}

/** 用户名/密码基础校验（中文用户名允许；拒绝空白与超长） */
export function validateCredentials(username: string, password: string): string | null {
  if (!username || username.trim().length < 2 || username.trim().length > 24) {
    return "用户名需 2–24 个字符";
  }
  if (/\s/.test(username)) return "用户名不能包含空白字符";
  if (password.length < 8 || password.length > 128) return "密码需 8–128 个字符";
  return null;
}

/* ── 登录尝试限流（进程内滑动窗口；单实例足够） ── */

const attempts = new Map<string, { count: number; resetAt: number }>();

export function loginRateLimit(key: string, limit = 10, windowMs = 60_000): boolean {
  const entry = attempts.get(key);
  const ts = Date.now();
  if (!entry || entry.resetAt < ts) {
    attempts.set(key, { count: 1, resetAt: ts + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

/** 客户端 IP（反代场景读 x-forwarded-for 第一段） */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
