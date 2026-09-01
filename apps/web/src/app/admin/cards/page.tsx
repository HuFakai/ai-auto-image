import { getRuntime } from "@/server/runtime";
import { CardsView, type Benefit } from "./cards-view";

export const dynamic = "force-dynamic";

function parseStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export default async function AdminCardsPage() {
  const runtime = await getRuntime();
  const [settings, batches, apiKeys, plans, summary, webhooks] = await Promise.all([
    runtime.cardSystem.settings(),
    runtime.cardRepo.listBatches({ page: 1, pageSize: 20 }),
    runtime.cardRepo.listApiKeys(),
    runtime.planRepo.list(false),
    runtime.cardRepo.summary(),
    runtime.cardRepo.listWebhookDeliveries(1, 20),
  ]);
  const initialBatches = await Promise.all(
    batches.items.map(async (batch) => {
      let benefit: Benefit | null = null;
      try { benefit = JSON.parse(batch.benefitJson) as Benefit; } catch { /* no-op */ }
      return { ...batch, benefit, stats: await runtime.cardRepo.batchStats(batch.id) };
    }),
  );
  return (
    <CardsView
      initialSettings={settings}
      initialBatches={initialBatches}
      initialPagination={{ total: batches.total, page: batches.page, pageSize: batches.pageSize, totalPages: batches.totalPages }}
      initialApiKeys={apiKeys.map((row) => ({
        id: row.id,
        name: row.name,
        keyPrefix: row.keyPrefix,
        scopes: parseStringList(row.scopesJson),
        ipAllowlist: parseStringList(row.ipAllowlistJson),
        rateLimitPerMinute: row.rateLimitPerMinute,
        webhookUrl: row.webhookUrl,
        status: row.status,
        lastUsedAt: row.lastUsedAt,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      }))}
      initialWebhooks={{
        items: webhooks.items.map((item) => ({
          id: item.id,
          eventId: item.eventId,
          eventType: item.eventType,
          resourceId: item.resourceId,
          endpointUrl: item.endpointUrl,
          status: item.status,
          attempts: item.attempts,
          nextAttemptAt: item.nextAttemptAt,
          lastError: item.lastError,
          deliveredAt: item.deliveredAt,
          createdAt: item.createdAt,
        })),
        pagination: { total: webhooks.total, page: webhooks.page, pageSize: webhooks.pageSize, totalPages: webhooks.totalPages },
      }}
      plans={plans.map((plan) => ({ id: plan.id, name: plan.name, periodDays: plan.periodDays, creditsPerPeriod: plan.creditsPerPeriod }))}
      summary={summary}
    />
  );
}
