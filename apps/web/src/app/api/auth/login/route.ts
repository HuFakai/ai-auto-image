import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  clientIp,
  issueSession,
  loginRateLimit,
  sessionCookieOptions,
  verifyPassword,
} from "@/server/auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!loginRateLimit(`login:${clientIp(request)}`)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }

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

  const runtime = await getRuntime();
  const user = await runtime.userRepo.findByUsername(username);
  // 统一错误信息，不暴露用户名是否存在
  if (!user || !user.passwordHash || user.status !== "active" || !(await verifyPassword(password, user.passwordHash))) {
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
