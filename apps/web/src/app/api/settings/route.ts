import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { settings } from "@/server/db/schema";
import { getProviderConfig } from "@/server/providers";
import { concurrencyConfig } from "@/server/config";
import { OpenAiTextProvider } from "@aai/provider-openai";
import { XaiImageProvider } from "@aai/provider-xai";

const PutSchema = z.object({
  text: z
    .object({
      baseUrl: z.string().url(),
      apiKey: z.string().min(1),
      model: z.string().min(1),
    })
    .nullable()
    .optional(),
  image: z
    .object({
      baseUrl: z.string().url(),
      apiKey: z.string().min(1),
      model: z.string().min(1),
      editModel: z.string().optional(),
    })
    .nullable()
    .optional(),
});

function maskKey(key: string): string {
  return key.length <= 8 ? "***" : `${key.slice(0, 6)}***${key.slice(-4)}`;
}

export async function GET() {
  const cfg = getProviderConfig();
  return NextResponse.json({
    text: cfg.text ? { ...cfg.text, apiKey: maskKey(cfg.text.apiKey) } : null,
    image: cfg.image ? { ...cfg.image, apiKey: maskKey(cfg.image.apiKey) } : null,
    concurrency: concurrencyConfig(),
  });
}

export async function PUT(req: Request) {
  const body = PutSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  const db = getDb();
  const current = getProviderConfig();
  const next = {
    text: body.data.text !== undefined ? body.data.text : current.text,
    image: body.data.image !== undefined ? body.data.image : current.image,
    compatible: current.compatible,
  };
  db.insert(settings)
    .values({ key: "provider_config", value: JSON.stringify(next), updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(next), updatedAt: new Date().toISOString() },
    })
    .run();
  return NextResponse.json({ ok: true });
}

/** POST — live connectivity test for one side. */
export async function POST(req: Request) {
  const body = z
    .object({
      target: z.enum(["text", "image"]),
      baseUrl: z.string().url(),
      apiKey: z.string(),
      model: z.string(),
    })
    .safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "参数错误" }, { status: 400 });
  const { target, baseUrl, apiKey, model } = body.data;
  try {
    if (target === "text") {
      const p = new OpenAiTextProvider({ baseUrl, apiKey, model });
      const res = await p.generateText({ prompt: "回复两个字：正常", maxTokens: 200 });
      return NextResponse.json({ ok: true, sample: res.text.slice(0, 50), usage: res.usage });
    }
    const p = new XaiImageProvider({ baseUrl, apiKey, model });
    const res = await p.generate({ prompt: "a simple red circle on white background", n: 1, responseFormat: "url" });
    return NextResponse.json({ ok: true, images: res.images.length, url: res.images[0]?.url?.slice(0, 80) });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "连接失败" },
      { status: 502 }
    );
  }
}
