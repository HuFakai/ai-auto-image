import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { projects } from "@/server/db/schema";
import { RecipeIdSchema, PlatformSchema, AspectRatioSchema, TextRenderingModeSchema } from "@aai/shared-schemas";
import { newId } from "@aai/ai-core";
import { recipeOf } from "@/server/recipes";
import { resolveEffectiveConcurrency } from "@/server/config";

const CreateProjectSchema = z.object({
  title: z.string().max(100).optional(),
  recipeId: RecipeIdSchema,
  platform: PlatformSchema,
  aspectRatio: AspectRatioSchema,
  textRenderingMode: TextRenderingModeSchema.default("native"),
  themeId: z.string().default("minimal-knowledge"),
  brandKitId: z.string().optional(),
  inputKind: z.enum(["topic", "article", "product", "book"]).default("topic"),
  inputText: z.string().default(""),
  productData: z.record(z.unknown()).optional(),
  bookData: z.record(z.unknown()).optional(),
  imageConcurrency: z.number().int().min(1).max(16).default(1),
});

export async function GET() {
  const db = getDb();
  const rows = db.select().from(projects).where(eq(projects.archived, 0)).orderBy(desc(projects.updatedAt)).all();
  return NextResponse.json({ projects: rows });
}

export async function POST(req: Request) {
  const body = CreateProjectSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "参数错误", detail: body.error.flatten() }, { status: 400 });
  }
  const input = body.data;
  const recipe = recipeOf(input.recipeId);

  // input validation per recipe
  if (input.inputKind === "topic" && input.inputText.trim().length < 2) {
    return NextResponse.json({ error: `${recipe.requiredInput}` }, { status: 400 });
  }
  if (input.inputKind === "article" && input.inputText.trim().length < 50) {
    return NextResponse.json({ error: "文章内容太短（至少 50 字）" }, { status: 400 });
  }
  if (input.inputKind === "product" && !input.productData) {
    return NextResponse.json({ error: "请填写商品资料" }, { status: 400 });
  }
  if (input.inputKind === "book" && !input.bookData) {
    return NextResponse.json({ error: "请填写图书资料" }, { status: 400 });
  }

  const conc = resolveEffectiveConcurrency(input.imageConcurrency);
  const db = getDb();
  const id = newId("proj");
  db.insert(projects)
    .values({
      id,
      title: input.title?.trim() || input.inputText.slice(0, 30) || recipe.name,
      recipeId: input.recipeId,
      platform: input.platform,
      aspectRatio: input.aspectRatio,
      textRenderingMode: input.textRenderingMode,
      themeId: input.themeId || recipe.defaultTheme,
      brandKitId: input.brandKitId ?? null,
      inputKind: input.inputKind,
      inputText: input.inputText,
      productData: input.productData ? JSON.stringify(input.productData) : null,
      bookData: input.bookData ? JSON.stringify(input.bookData) : null,
      imageConcurrency: conc.effective,
    })
    .run();
  const created = db.select().from(projects).where(eq(projects.id, id)).get();
  return NextResponse.json({ project: created, concurrency: conc }, { status: 201 });
}
