import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { apiKeys, webhooks, workspaces } from "@/server/db/schema";
import { createApiKey, usageSummary, monthUsageCents, budgetExceededCents } from "@/server/openplatform";
import { newId } from "@aai/ai-core";

export async function GET() {
  const db = getDb();
  const keys = db.select().from(apiKeys).all().map((k) => ({ ...k, keyHash: undefined }));
  const hooks = db.select().from(webhooks).all().map((h) => ({ ...h, secret: "***" }));
  const ws = db.select().from(workspaces).where(eq(workspaces.id, "ws_default")).get();
  return NextResponse.json({
    keys,
    webhooks: hooks,
    workspace: ws,
    usage: usageSummary(30),
    monthUsageCents: monthUsageCents(),
    budgetExceededCents: budgetExceededCents(),
  });
}

const PostSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_key"),
    name: z.string().min(1).max(50),
    scopes: z.array(z.string()).default(["generate", "export"]),
  }),
  z.object({
    action: z.literal("revoke_key"),
    id: z.string(),
  }),
  z.object({
    action: z.literal("create_webhook"),
    url: z.string().url(),
    events: z.array(z.string()).min(1),
  }),
  z.object({
    action: z.literal("delete_webhook"),
    id: z.string(),
  }),
  z.object({
    action: z.literal("set_budget"),
    monthlyBudgetCny: z.number().int().nullable(),
  }),
]);

export async function POST(req: Request) {
  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  const db = getDb();
  const input = parsed.data;

  switch (input.action) {
    case "create_key": {
      const created = createApiKey(input.name, input.scopes);
      return NextResponse.json(created, { status: 201 });
    }
    case "revoke_key": {
      db.update(apiKeys).set({ revoked: 1 }).where(eq(apiKeys.id, input.id)).run();
      return NextResponse.json({ ok: true });
    }
    case "create_webhook": {
      const id = newId("wh");
      db.insert(webhooks)
        .values({ id, url: input.url, events: JSON.stringify(input.events), secret: newId("sec") })
        .run();
      return NextResponse.json({ id }, { status: 201 });
    }
    case "delete_webhook": {
      db.delete(webhooks).where(eq(webhooks.id, input.id)).run();
      return NextResponse.json({ ok: true });
    }
    case "set_budget": {
      db.update(workspaces)
        .set({ monthlyBudgetCny: input.monthlyBudgetCny })
        .where(eq(workspaces.id, "ws_default"))
        .run();
      return NextResponse.json({ ok: true });
    }
  }
}
