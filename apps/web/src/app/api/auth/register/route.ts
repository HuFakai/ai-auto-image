import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  clientIp,
  hashPassword,
  issueSession,
  loginRateLimit,
  registerPolicy,
  sessionCookieOptions,
  validateCredentials,
} from "@/server/auth";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!loginRateLimit(`register:${clientIp(request)}`, 5)) {
    return NextResponse.json({ error: "尝试过于频繁，请稍后再试" }, { status: 429 });
  }

  let body: { username?: unknown; password?: unknown; inviteCode?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode : undefined;

  const invalid = validateCredentials(username, password);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const policy = await registerPolicy(inviteCode);
  if (!policy.allowed) return NextResponse.json({ error: policy.reason }, { status: 403 });

  const runtime = await getRuntime();
  if (await runtime.userRepo.findByUsername(username)) {
    return NextResponse.json({ error: "用户名已被使用" }, { status: 409 });
  }

  const user = await runtime.userRepo.create({
    username,
    passwordHash: await hashPassword(password),
    role: policy.role,
  });
  const token = await issueSession(user.id);
  const response = NextResponse.json(
    { userId: user.id, username: user.username, role: user.role },
    { status: 201 },
  );
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return response;
}
