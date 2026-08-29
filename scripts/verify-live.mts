/** 真实渠道验证（TEXT_* / IMAGE_* 环境变量）：pnpm verify:live */
import { loadDotEnv } from "./lib/env.js";
import { runVerify } from "./lib/verify.js";
import { compatibleRoute, createOpenAICompatProvider, createWireClient } from "@aai/provider-openai";

loadDotEnv();

const textBase = process.env.TEXT_BASE_URL;
const textKey = process.env.TEXT_API_KEY;
const imageBase = process.env.IMAGE_BASE_URL;
const imageKey = process.env.IMAGE_API_KEY;

if (!textBase || !textKey || !imageBase || !imageKey) {
  console.error("缺少 TEXT_BASE_URL / TEXT_API_KEY / IMAGE_BASE_URL / IMAGE_API_KEY 配置（.env）");
  process.exit(1);
}

const textConfig = compatibleRoute({
  baseUrl: textBase,
  id: "text-compatible",
  apiKeyRef: "TEXT_API_KEY",
  textModel: process.env.TEXT_MODEL ?? "deepseek-v4-flash",
  maxAttempts: 3,
});
const textBundle = createOpenAICompatProvider({
  config: textConfig,
  apiKey: textKey,
  client: createWireClient(textConfig, textKey),
  capabilities: { text: { structuredOutput: true, imageInput: process.env.TEXT_VISION === "1" } },
});

const imageConfig = compatibleRoute({
  baseUrl: imageBase,
  id: "image-compatible",
  apiKeyRef: "IMAGE_API_KEY",
  imageModel: process.env.IMAGE_MODEL ?? "grok-imagine-image-2.0",
  maxAttempts: 3,
});
const imageBundle = createOpenAICompatProvider({
  config: imageConfig,
  apiKey: imageKey,
  client: createWireClient(imageConfig, imageKey),
  capabilities: {
    imageRequest: {
      aspectRatioParam: (process.env.IMAGE_ASPECT_RATIO_PARAM as "size" | "aspect_ratio") ?? "aspect_ratio",
      responseFormat: (process.env.IMAGE_RESPONSE_FORMAT as "url" | "b64_json") ?? "b64_json",
    },
  },
});

await runVerify({
  label: "live",
  textModel: textBundle.text!,
  imageModel: imageBundle.image!,
  routes: [{ config: imageConfig, model: imageBundle.image!.model }],
});
