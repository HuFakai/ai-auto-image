import { NextResponse } from "next/server";
import { getRuntime } from "@/server/runtime";
import { requireApiUser } from "@/server/auth";
import { STARTER_CREDITS, CREDIT_CENTS } from "@/server/billing";

export const dynamic = "force-dynamic";

/** 套餐与点数包（上架中的）；附带计价说明，供充值页渲染 */
export async function GET() {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const runtime = await getRuntime();
  const [plans, packages] = await Promise.all([
    runtime.planRepo.list(true),
    runtime.packageRepo.list(true),
  ]);
  return NextResponse.json({
    plans: plans.map((plan) => ({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description,
      priceCents: plan.priceCents,
      periodDays: plan.periodDays,
      creditsPerPeriod: plan.creditsPerPeriod,
      features: JSON.parse(plan.featuresJson || "[]") as string[],
    })),
    packages: packages.map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      credits: pkg.credits,
      bonusCredits: pkg.bonusCredits,
      priceCents: pkg.priceCents,
    })),
    pricing: { creditCents: CREDIT_CENTS, starterCredits: STARTER_CREDITS },
    payChannels: {
      alipay: Boolean(process.env.PAY_NOTIFY_BASE_URL),
      note: "渠道可用性以下单接口返回为准",
    },
  });
}
