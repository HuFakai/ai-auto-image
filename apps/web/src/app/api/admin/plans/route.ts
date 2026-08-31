import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireAdmin } from "@/server/auth";
import type { CreatePlanInput, CreatePackageInput } from "@aai/storage";

export const dynamic = "force-dynamic";

/** 套餐管理：订阅套餐 + 点数包 的 CRUD（分 type 路由） */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const runtime = await getRuntime();
  const [plans, packages] = await Promise.all([runtime.planRepo.list(false), runtime.packageRepo.list(false)]);
  return NextResponse.json({
    plans: plans.map((plan) => ({
      ...plan,
      features: JSON.parse(plan.featuresJson || "[]") as string[],
    })),
    packages,
  });
}

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const runtime = await getRuntime();
  try {
    if (body.kind === "plan") {
      const input = body as unknown as CreatePlanInput;
      if (!input.code || !input.name || !input.priceCents || !input.creditsPerPeriod) {
        return NextResponse.json({ error: "code/name/priceCents/creditsPerPeriod 必填" }, { status: 400 });
      }
      if (await runtime.planRepo.findByCode(input.code)) {
        return NextResponse.json({ error: "套餐 code 已存在" }, { status: 409 });
      }
      const plan = await runtime.planRepo.create(input);
      return NextResponse.json({ id: plan.id }, { status: 201 });
    }
    if (body.kind === "package") {
      const input = body as unknown as CreatePackageInput;
      if (!input.name || !input.credits || !input.priceCents) {
        return NextResponse.json({ error: "name/credits/priceCents 必填" }, { status: 400 });
      }
      const pkg = await runtime.packageRepo.create(input);
      return NextResponse.json({ id: pkg.id }, { status: 201 });
    }
    return NextResponse.json({ error: "kind 必须为 plan|package" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 200) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (!body.id || typeof body.id !== "string") return NextResponse.json({ error: "id required" }, { status: 400 });
  const runtime = await getRuntime();
  try {
    if (body.kind === "plan") {
      const { id, kind, ...patch } = body as { id: string; kind: string } & Partial<CreatePlanInput>;
      void kind;
      const plan = await runtime.planRepo.update(id, patch);
      return NextResponse.json({ id: plan.id });
    }
    if (body.kind === "package") {
      const { id, kind, ...patch } = body as { id: string; kind: string } & Partial<CreatePackageInput>;
      void kind;
      const pkg = await runtime.packageRepo.update(id, patch);
      return NextResponse.json({ id: pkg.id });
    }
    return NextResponse.json({ error: "kind 必须为 plan|package" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error).slice(0, 200) }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const id = url.searchParams.get("id");
  if (!id || (kind !== "plan" && kind !== "package")) {
    return NextResponse.json({ error: "kind=plan|package 与 id 必填" }, { status: 400 });
  }
  const runtime = await getRuntime();
  try {
    if (kind === "plan") await runtime.planRepo.delete(id);
    else await runtime.packageRepo.delete(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "删除失败：可能已有订单引用，请改为下架" }, { status: 409 });
  }
}
