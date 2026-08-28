import { createReadStream, existsSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Readable } from "node:stream";
import { eq, isNull } from "drizzle-orm";
import { getDb } from "@/server/db";
import { assets } from "@/server/db/schema";

type Params = { params: Promise<{ id: string }> };

/** id = export asset id. Streams the ZIP from the data volume. */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const db = getDb();
  const row = db.select().from(assets).where(eq(assets.id, id)).get();
  if (!row || row.kind !== "export" || row.deleted || !existsSync(row.path)) {
    return NextResponse.json({ error: "导出包不存在" }, { status: 404 });
  }
  const stat = statSync(row.path);
  const nodeStream = createReadStream(row.path);
  const webStream = Readable.toWeb(nodeStream) as WebReadableStream<Uint8Array>;
  return new NextResponse(webStream as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${id}.zip"`,
    },
  });
}

export const dynamic = "force-dynamic";
