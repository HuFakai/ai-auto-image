import { NextResponse } from "next/server";
import { InsufficientWalletCreditsError } from "@aai/storage";
import { getRuntime } from "@/server/runtime";
import { requireAdmin } from "@/server/auth";

export const dynamic = "force-dynamic";

/** 用户管理：列表（含钱包/订阅）、角色/状态变更、点数调整 */
export async function GET(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() || undefined;
  const runtime = await getRuntime();
  const users = await runtime.userRepo.listAdmin(q, 100);
  const ids = users.map((user) => user.id);
  const [wallets, subs] = await Promise.all([
    runtime.walletRepo.forUsers(ids),
    runtime.subscriptionRepo.listActiveForUsers(ids),
  ]);
  const planNames = new Map((await runtime.planRepo.list(false)).map((plan) => [plan.id, plan.name]));
  return NextResponse.json({
    users: users.map((user) => {
      const wallet = wallets.get(user.id);
      const sub = subs.find((row) => row.userId === user.id);
      return {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        authProvider: user.authProvider,
        createdAt: user.createdAt,
        balance: wallet ? wallet.balance - wallet.reservedCredits : 0,
        reserved: wallet?.reservedCredits ?? 0,
        totalGranted: wallet?.totalGranted ?? 0,
        totalConsumed: wallet?.totalConsumed ?? 0,
        subscription: sub
          ? {
              planName: planNames.get(sub.planId) ?? "已删除套餐",
              expiresAt: sub.expiresAt,
            }
          : null,
      };
    }),
  });
}

/** 变更角色/状态 */
export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as {
    userId?: string;
    role?: "admin" | "user";
    status?: "active" | "disabled";
  };
  if (!body.userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  if (body.userId === admin.id && (body.role === "user" || body.status === "disabled")) {
    return NextResponse.json({ error: "不能对自己降级或停用" }, { status: 400 });
  }
  const runtime = await getRuntime();
  let user = await runtime.userRepo.require(body.userId);
  if (body.role) user = await runtime.userRepo.updateRole(user.id, body.role);
  if (body.status) {
    user = await runtime.userRepo.updateStatus(user.id, body.status);
    if (body.status === "disabled") await runtime.sessionRepo.deleteByUser(user.id);
  }
  return NextResponse.json({ id: user.id, role: user.role, status: user.status });
}

/** 手工调整点数 */
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { userId?: string; delta?: number; note?: string };
  const note = body.note?.trim() ?? "";
  if (!body.userId || typeof body.delta !== "number" || !Number.isInteger(body.delta) || body.delta === 0 || !note) {
    return NextResponse.json({ error: "userId、非零整数 delta 与调整理由均必填" }, { status: 400 });
  }
  const runtime = await getRuntime();
  await runtime.userRepo.require(body.userId);
  try {
    const result = await runtime.billing.adminAdjust(body.userId, body.delta, note, admin.id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof InsufficientWalletCreditsError) {
      return NextResponse.json(
        { error: `用户可用余额不足：当前 ${error.balance} 点，无法扣减 ${error.needed} 点` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: String(error).slice(0, 200) }, { status: 500 });
  }
}
