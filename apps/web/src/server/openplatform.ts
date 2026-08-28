import { createHash, randomBytes } from "node:crypto";
import { eq, gte, and } from "drizzle-orm";
import { getDb } from "./db";
import { apiKeys, projects, providerUsages, webhooks, workflowRuns, workspaces } from "./db/schema";
import type { WebhookEvent } from "@aai/shared-schemas";
import { newId } from "@aai/ai-core";

// ---------------------------------------------------------------------------
// API keys (phase 4): stored hashed; the plaintext is shown once at creation.
// ---------------------------------------------------------------------------

export function createApiKey(name: string, scopes: string[]): { id: string; key: string; prefix: string } {
  const db = getDb();
  const raw = `aak_${randomBytes(24).toString("base64url")}`;
  const id = newId("ak");
  const prefix = raw.slice(0, 12);
  db.insert(apiKeys)
    .values({
      id,
      name,
      keyHash: hashKey(raw),
      prefix,
      scopes: JSON.stringify(scopes),
    })
    .run();
  return { id, key: raw, prefix };
}

export function verifyApiKey(raw: string): { valid: boolean; scopes: string[]; id?: string } {
  const db = getDb();
  const row = db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashKey(raw))).get();
  if (!row || row.revoked) return { valid: false, scopes: [] };
  db.update(apiKeys).set({ lastUsedAt: new Date().toISOString() }).where(eq(apiKeys.id, row.id)).run();
  return { valid: true, scopes: JSON.parse(row.scopes) as string[], id: row.id };
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// ---------------------------------------------------------------------------
// Webhooks (phase 4): HMAC-signed POSTs, delivery is best-effort and logged.
// ---------------------------------------------------------------------------

export async function dispatchWebhook(event: WebhookEvent, data: unknown): Promise<void> {
  const db = getDb();
  const hooks = db.select().from(webhooks).where(eq(webhooks.enabled, 1)).all();
  const targets = hooks.filter((h) => (JSON.parse(h.events) as string[]).includes(event));
  await Promise.all(
    targets.map(async (h) => {
      const body = JSON.stringify({ event, data, timestamp: Date.now() });
      const signature = createHash("sha256").update(`${h.secret}.${body}`).digest("hex");
      try {
        await fetch(h.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-AAI-Signature": signature },
          body,
        });
      } catch (err) {
        console.error("[webhook] delivery failed", h.url, err instanceof Error ? err.message : err);
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Cost governance (phase 4): budget checks before expensive runs.
// ---------------------------------------------------------------------------

/** Cents are stored as integers (integer cents of CNY). */
export function monthUsageCents(workspaceId = "ws_default"): number {
  const db = getDb();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const rows = db
    .select()
    .from(providerUsages)
    .where(and(eq(providerUsages.workspaceId, workspaceId), gte(providerUsages.createdAt, monthStart.toISOString())))
    .all();
  return rows.reduce((s, r) => s + r.costCny, 0);
}

export function budgetExceededCents(): number | null {
  const db = getDb();
  const row = db.select().from(workspaces).where(eq(workspaces.id, "ws_default")).get();
  const budgetCents = row?.monthlyBudgetCny ?? null;
  if (!budgetCents) return null;
  const used = monthUsageCents();
  return used >= budgetCents ? used : null;
}

export interface UsageSummary {
  totalCents: number;
  byModel: Array<{ model: string; imageCount: number; promptTokens: number; completionTokens: number; cents: number }>;
  byDay: Array<{ day: string; cents: number }>;
}

export function usageSummary(days = 30): UsageSummary {
  const db = getDb();
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = db.select().from(providerUsages).where(gte(providerUsages.createdAt, since)).all();
  const byModel = new Map<string, { model: string; imageCount: number; promptTokens: number; completionTokens: number; cents: number }>();
  const byDay = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    total += r.costCny;
    const m = byModel.get(r.model) ?? { model: r.model, imageCount: 0, promptTokens: 0, completionTokens: 0, cents: 0 };
    m.imageCount += r.imageCount;
    m.promptTokens += r.promptTokens;
    m.completionTokens += r.completionTokens;
    m.cents += r.costCny;
    byModel.set(r.model, m);
    const day = r.createdAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + r.costCny);
  }
  return {
    totalCents: total,
    byModel: [...byModel.values()].sort((a, b) => b.cents - a.cents),
    byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, cents]) => ({ day, cents })),
  };
}

export function projectStats(projectId: string) {
  const db = getDb();
  const runs = db.select().from(workflowRuns).where(eq(workflowRuns.projectId, projectId)).all();
  const usages = db.select().from(providerUsages).all().filter((u) => runs.some((r) => r.id === u.runId));
  return {
    runCount: runs.length,
    totalCostCents: usages.reduce((s, u) => s + u.costCny, 0),
    imageCount: usages.reduce((s, u) => s + u.imageCount, 0),
  };
}

export function assertProjectExists(projectId: string): void {
  const db = getDb();
  if (!db.select().from(projects).where(eq(projects.id, projectId)).get()) {
    throw new Error(`project ${projectId} not found`);
  }
}
