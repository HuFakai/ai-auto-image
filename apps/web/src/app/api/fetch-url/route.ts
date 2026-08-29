import { NextResponse } from "next/server";
import { z } from "zod";
import { assertPublicHttpUrl, fetchReadable } from "@/lib/url-text";
import { requireApiUser } from "@/server/auth";

export const dynamic = "force-dynamic";

const Schema = z.object({ url: z.string().min(1).max(500) });

/** URL 抓取（实验能力）：提取标题与正文，失败时前端降级为粘贴正文 */
export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid input" }, { status: 400 });
  }

  try {
    const url = assertPublicHttpUrl(parsed.data.url);
    const result = await fetchReadable(url);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message.slice(0, 200) : String(error) },
      { status: 422 },
    );
  }
}
