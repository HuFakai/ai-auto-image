import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { settings } from "./db/schema";
import { OpenAiTextProvider } from "@aai/provider-openai";
import { XaiImageProvider } from "@aai/provider-xai";
import type { ImageModel, TextModel } from "@aai/ai-core";
import { createCompatibleImageModel, createCompatibleTextModel, CompatibleProviderConfigSchema } from "@aai/provider-compatible";

/**
 * Provider registry. Defaults come from env; the settings page can override
 * via the `provider_config` settings row (JSON). Custom compatible providers
 * declare capabilities explicitly — never inferred from the model name.
 */
export interface ProviderConfig {
  text: { baseUrl: string; apiKey: string; model: string } | null;
  image: { baseUrl: string; apiKey: string; model: string; editModel?: string } | null;
  compatible: unknown[];
}

export function getProviderConfig(): ProviderConfig {
  let override: Partial<ProviderConfig> = {};
  try {
    const db = getDb();
    const row = db.select().from(settings).where(eq(settings.key, "provider_config")).get();
    if (row) override = JSON.parse(row.value) as Partial<ProviderConfig>;
  } catch {
    // settings table not ready (e.g. first boot before migration) — env only
  }
  const envText =
    process.env.TEXT_PROVIDER_BASE_URL && process.env.TEXT_PROVIDER_API_KEY && process.env.TEXT_PROVIDER_MODEL
      ? {
          baseUrl: process.env.TEXT_PROVIDER_BASE_URL,
          apiKey: process.env.TEXT_PROVIDER_API_KEY,
          model: process.env.TEXT_PROVIDER_MODEL,
        }
      : null;
  const envImage =
    process.env.IMAGE_PROVIDER_BASE_URL && process.env.IMAGE_PROVIDER_API_KEY && process.env.IMAGE_PROVIDER_MODEL
      ? {
          baseUrl: process.env.IMAGE_PROVIDER_BASE_URL,
          apiKey: process.env.IMAGE_PROVIDER_API_KEY,
          model: process.env.IMAGE_PROVIDER_MODEL,
        }
      : null;
  return {
    text: override.text ?? envText,
    image: override.image ?? envImage,
    compatible: override.compatible ?? [],
  };
}

export function getTextModel(cfg = getProviderConfig()): TextModel | null {
  if (!cfg.text) return null;
  return new OpenAiTextProvider(cfg.text);
}

export function getImageModel(cfg = getProviderConfig()): ImageModel | null {
  if (cfg.image) {
    return new XaiImageProvider({ ...cfg.image, editModel: cfg.image.editModel ?? cfg.image.model });
  }
  for (const raw of cfg.compatible) {
    const parsed = CompatibleProviderConfigSchema.safeParse(raw);
    if (parsed.success) {
      const model = createCompatibleImageModel(parsed.data);
      if (model) return model;
    }
  }
  return null;
}
