import { NextResponse } from "next/server";
import { getDb } from "@/server/db";
import { platformAccounts, publishJobs, projects } from "@/server/db/schema";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@aai/ai-core";
import { getAdapter } from "@/server/platform";

export async function GET() {
  const db = getDb();
  return NextResponse.json({
    accounts: db.select().from(platformAccounts).all(),
    jobs: db.select().from(publishJobs).orderBy(desc(publishJobs.createdAt)).limit(100).all(),
  });
}

const PostSchema = z.object({
  platform: z.enum(["xiaohongshu", "douyin", "wechat"]),
  alias: z.string().min(1).max(50),
  credential: z.string().optional(),
});

export async function POST(req: Request) {
  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  const db = getDb();
  const id = newId("acc");
  db.insert(platformAccounts)
    .values({
      id,
      platform: parsed.data.platform,
      alias: parsed.data.alias,
      credential: parsed.data.credential ?? null,
    })
    .run();
  const adapter = getAdapter(parsed.data.platform);
  const status = adapter ? await adapter.checkAuth(id) : { ok: false, message: "平台暂不支持" };
  db.update(platformAccounts)
    .set({ lastCheckedAt: new Date().toISOString(), lastStatus: status.message })
    .where(eq(platformAccounts.id, id))
    .run();
  return NextResponse.json({ id, status }, { status: 201 });
}

/** 内容日历数据：以 publishJobs.scheduledAt 为轴线 */
export async function PUT(req: Request) {
  // schedule / reschedule a publish job
  const body = z
    .object({ jobId: z.string(), scheduledAt: z.string().datetime().nullable() })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  const db = getDb();
  db.update(publishJobs)
    .set({ scheduledAt: body.data.scheduledAt, updatedAt: new Date().toISOString() })
    .where(eq(publishJobs.id, body.data.jobId))
    .run();
  return NextResponse.json({ ok: true });
}
