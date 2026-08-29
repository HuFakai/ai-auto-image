import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  clientIp,
  getDummyHash,
  issueSession,
  loginRateLimit,
  sessionCookieOptions,
  verifyPassword,
} from "@/server/auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return NextResponse.json({ error: "请输入用户名和密码" }, { status: 400 });
  }

  // 限流 key 为 IP + 账号双成分：单点伪造 IP 无法对同一账号无限爆破
  if (!loginRateLimit(`login:${clientIp(request)}:${username}`)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }

  const runtime = await getRuntime();
  const user = await runtime.userRepo.findByUsername(username);
  // 统一错误信息，不暴露用户名是否存在；用户不存在/无密码时也对固定 dummy 哈希执行一次
  // scrypt，避免「用户不存在更快」的时序侧信道枚举。
  const passwordHash = user?.passwordHash || null;
  const passwordOk = await verifyPassword(password, passwordHash ?? (await getDummyHash()));
  if (!user || !passwordHash || user.status !== "active" || !passwordOk) {
    return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
  }

  const token = await issueSession(user.id, user.authProvider);
  const response = NextResponse.json({
    userId: user.id,
    username: user.username,
    role: user.role,
  });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}
