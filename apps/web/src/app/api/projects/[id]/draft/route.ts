import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { projects, publishJobs } from "@/server/db/schema";
import { createPlatformDraft, getAdapter, listPlatformAccounts } from "@/server/platform";
import type { PlatformDraftInput, PublishAuthorization, Storyboard } from "@aai/shared-schemas";
import { newId } from "@aai/ai-core";

type Params = { params: Promise<{ id: string }> };

const DraftSchema = z.object({
  platform: z.enum(["xiaohongshu", "wechat"]),
  accountId: z.string().min(1),
  scope: z.enum(["draft", "publish"]).default("draft"),
  title: z.string().min(1).max(64),
  body: z.string().min(1),
  tags: z.array(z.string()).default([]),
  // explicit publish authorization — never derived from final approval
  authorization: z.object({
    userId: z.string().default("user_default"),
    accountAlias: z.string(),
    confirm: z.literal(true),
  }),
});

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = DraftSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误", detail: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;
  const db = getDb();
  const project = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!project?.storyboard) return NextResponse.json({ error: "项目尚未完成生成" }, { status: 400 });

  // collect final page images
  const { assets } = await import("@/server/db/schema");
  const { and } = await import("drizzle-orm");
  const pageAssets = db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, id), eq(assets.deleted, 0)))
    .all()
    .filter((a) => a.slideIndex !== null)
    .sort((a, b) => (a.slideIndex ?? 0) - (b.slideIndex ?? 0));

  const storyboard = JSON.parse(project.storyboard) as Storyboard;
  const draftInput: PlatformDraftInput = {
    platform: input.platform,
    accountId: input.accountId,
    projectVersion: project.updatedAt,
    title: input.title,
    body: input.body,
    tags: input.tags,
    imageAssetIds: pageAssets.map((a) => a.id),
    visibility: "draft",
  };
  const authorization: PublishAuthorization = {
    userId: input.authorization.userId,
    platform: input.platform,
    accountAlias: input.authorization.accountAlias,
    projectVersion: project.updatedAt,
    titleSummary: input.title.slice(0, 30),
    imageCount: pageAssets.length,
    authorizedAt: new Date().toISOString(),
    scope: input.scope,
  };

  try {
    const result = await createPlatformDraft({
      projectId: id,
      platform: input.platform,
      accountId: input.accountId,
      scope: input.scope,
      input: draftInput,
      authorization,
    });
    return NextResponse.json({ ...result, message: result.duplicate ? "相同草稿已存在（幂等命中）" : "草稿创建成功" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "写入失败" }, { status: 502 });
  }
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const jobs = getDb().select().from(publishJobs).where(eq(publishJobs.projectId, id)).all();
  return NextResponse.json({ jobs, accounts: listPlatformAccounts(), adapters: ["xiaohongshu", "wechat"].map((p) => ({ platform: p, capabilities: getAdapter(p)?.capabilities() })) });
}
