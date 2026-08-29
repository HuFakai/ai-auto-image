import { NextResponse } from "next/server";
import { SESSION_COOKIE, destroyCurrentSession } from "@/server/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  await destroyCurrentSession();
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
