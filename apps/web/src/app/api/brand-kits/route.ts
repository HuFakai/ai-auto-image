import { NextResponse } from "next/server";
import { getDb } from "@/server/db";
import { brandKits } from "@/server/db/schema";
import { BUILTIN_THEMES } from "@aai/render-engine";

export async function GET() {
  const db = getDb();
  return NextResponse.json({
    brandKits: db.select().from(brandKits).all(),
    themes: Object.values(BUILTIN_THEMES).map((t) => ({ id: t.id, name: t.name })),
  });
}
