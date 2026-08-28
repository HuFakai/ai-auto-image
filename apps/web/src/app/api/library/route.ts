import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import z from "zod";
import { getDb } from "@/server/db";
import { assets, brandKits, projects } from "@/server/db/schema";
import { newId } from "@aai/ai-core";
import { BUILTIN_THEMES } from "@aai/render-engine";

/** Phase 4 content asset library: searchable, with lineage metadata. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  const projectId = url.searchParams.get("projectId");
  const q = url.searchParams.get("q");
  const db = getDb();

  let rows = db.select().from(assets).where(eq(assets.deleted, 0)).orderBy(desc(assets.createdAt)).limit(500).all();
  if (kind) rows = rows.filter((r) => r.kind === kind);
  if (projectId) rows = rows.filter((r) => r.projectId === projectId);
  if (q) {
    const needle = q.toLowerCase();
    const projectTitles = new Map(db.select().from(projects).all().map((p) => [p.id, p.title.toLowerCase()]));
    rows = rows.filter(
      (r) =>
        (r.projectId && projectTitles.get(r.projectId)?.includes(needle)) ||
        (r.meta ?? "").toLowerCase().includes(needle) ||
        r.id.includes(needle)
    );
  }
  return NextResponse.json({ assets: rows.slice(0, 200) });
}

const BrandKitSchema = z.object({
  name: z.string().min(1).max(50),
  brandName: z.string().optional(),
  primaryColor: z.string().default("#1a1a1a"),
  secondaryColor: z.string().default("#6b7280"),
  backgroundColor: z.string().default("#faf7f2"),
  watermark: z.string().optional(),
  tone: z.array(z.string()).default([]),
  bannedPhrases: z.array(z.string()).default([]),
  imageStyleKeywords: z.array(z.string()).default([]),
  imageNegativeKeywords: z.array(z.string()).default([]),
});

export async function POST(req: Request) {
  const parsed = BrandKitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "参数错误", detail: parsed.error.flatten() }, { status: 400 });
  const db = getDb();
  const id = newId("bk");
  db.insert(brandKits)
    .values({ id, name: parsed.data.name, data: JSON.stringify({ id, ...parsed.data }), builtin: 0 })
    .run();
  return NextResponse.json({ id }, { status: 201 });
}

export async function PUT(req: Request) {
  // list brand kits (GET-like but avoids route conflict)
  const db = getDb();
  return NextResponse.json({
    brandKits: db.select().from(brandKits).all(),
    themes: Object.values(BUILTIN_THEMES).map((t) => ({ id: t.id, name: t.name })),
  });
}
