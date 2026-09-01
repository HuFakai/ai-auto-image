import { requireUser } from "@/server/auth";
import { getRuntime } from "@/server/runtime";
import { PricingView, type OrderItem, type LedgerItem } from "./pricing-view";

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const user = await requireUser();
  const runtime = await getRuntime();
  const [summary, plans, packages, ordersPage, ledgerPage] = await Promise.all([
    runtime.billing.summary(user.id),
    runtime.planRepo.list(true),
    runtime.packageRepo.list(true),
    runtime.orderRepo.listByUserPage(user.id, 1, 20),
    runtime.ledgerRepo.listByUserPage(user.id, 1, 20),
  ]);

  return (
    <PricingView
      username={user.username}
      summary={summary}
      plans={plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        description: plan.description,
        priceCents: plan.priceCents,
        periodDays: plan.periodDays,
        creditsPerPeriod: plan.creditsPerPeriod,
        features: JSON.parse(plan.featuresJson || "[]") as string[],
      }))}
      packages={packages.map((pkg) => ({
        id: pkg.id,
        name: pkg.name,
        credits: pkg.credits,
        bonusCredits: pkg.bonusCredits,
        priceCents: pkg.priceCents,
      }))}
      orders={ordersPage.items.map(
        (order): OrderItem => ({
          id: order.id,
          orderNo: order.orderNo,
          title: order.title,
          type: order.type,
          amountCents: order.amountCents,
          credits: order.credits,
          channel: order.channel,
          status: order.status,
          createdAt: order.createdAt,
          paidAt: order.paidAt,
        }),
      )}
      ordersPagination={{
        total: ordersPage.total,
        page: ordersPage.page,
        pageSize: ordersPage.pageSize,
        totalPages: ordersPage.totalPages,
      }}
      ledger={ledgerPage.items.map(
        (row): LedgerItem => ({
          id: row.id,
          delta: row.delta,
          balanceAfter: row.balanceAfter,
          reason: row.reason,
          runId: row.runId,
          displayTitle: row.displayTitle,
          note: row.note,
          createdAt: row.createdAt,
        }),
      )}
      ledgerPagination={{
        total: ledgerPage.total,
        page: ledgerPage.page,
        pageSize: ledgerPage.pageSize,
        totalPages: ledgerPage.totalPages,
      }}
    />
  );
}
