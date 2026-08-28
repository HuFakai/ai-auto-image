import type { ImageCapabilities, TextModel } from "@aai/ai-core";
import { OpenAiTextProvider } from "@aai/provider-openai";
import { XaiImageProvider } from "@aai/provider-xai";
import { z } from "zod";

/**
 * User-configured OpenAI-compatible provider. Capabilities are declared
 * explicitly in settings — never inferred from the model name.
 */
export const CompatibleProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  textModel: z.string().optional(),
  imageModel: z.string().optional(),
  imageEditModel: z.string().optional(),
  capabilities: z
    .object({
      textToImage: z.boolean().default(false),
      singleReferenceEdit: z.boolean().default(false),
      multiReferenceEdit: z.boolean().default(false),
      maskEdit: z.boolean().default(false),
      maxImagesPerRequest: z.number().int().min(1).max(10).default(1),
      aspectRatios: z.array(z.string()).default(["1:1"]),
    })
    .optional(),
});
export type CompatibleProviderConfig = z.infer<typeof CompatibleProviderConfigSchema>;

export function createCompatibleTextModel(cfg: CompatibleProviderConfig): TextModel | null {
  if (!cfg.textModel) return null;
  return new OpenAiTextProvider({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.textModel,
  });
}

export function createCompatibleImageModel(cfg: CompatibleProviderConfig) {
  if (!cfg.imageModel) return null;
  const inner = new XaiImageProvider({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.imageModel,
    editModel: cfg.imageEditModel ?? cfg.imageModel,
  });
  const declared = cfg.capabilities;
  if (!declared) return inner;
  return {
    generate: inner.generate.bind(inner),
    edit: inner.edit.bind(inner),
    capabilities(): ImageCapabilities {
      const base = inner.capabilities();
      return {
        ...base,
        textToImage: declared.textToImage,
        singleReferenceEdit: declared.singleReferenceEdit,
        multiReferenceEdit: declared.multiReferenceEdit,
        maskEdit: declared.maskEdit,
        maxImagesPerRequest: declared.maxImagesPerRequest,
        aspectRatios: declared.aspectRatios as ImageCapabilities["aspectRatios"],
      };
    },
  };
}
