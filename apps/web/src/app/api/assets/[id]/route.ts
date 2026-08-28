import { createReadStream, existsSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db";
import { assets } from "@/server/db/schema";

type Params = { params: Promise<{ id: string }> };

/** Serve an asset file (page images, references) from the data volume. */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();
  const row = db.select().from(assets).where(eq(assets.id, id)).get();
  if (!row || row.deleted || !existsSync(row.path)) {
    return NextResponse.json({ error: "资产不存在" }, { status: 404 });
  }
  const stat = statSync(row.path);
  const nodeStream = createReadStream(row.path);
  const webStream = Readable.toWeb(nodeStream) as WebReadableStream<Uint8Array>;
  return new NextResponse(webStream as unknown as ReadableStream, {
    headers: {
      "Content-Type": row.mimeType,
      "Content-Length": String(stat.size),
      "Cache-Control": "private, max-age=3600",
    },
  });
}

export const dynamic = "force-dynamic";
