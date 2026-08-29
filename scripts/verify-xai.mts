/** xAI/Grok 真实调用验证：XAI_API_KEY=xai-... pnpm verify:xai */
import { loadDotEnv } from "./lib/env";
import { requireKey, runVerify } from "./lib/verify";
import { createXaiProvider } from "@aai/provider-xai";

loadDotEnv();
const apiKey = requireKey("XAI_API_KEY");

const bundle = createXaiProvider({ apiKey });

await runVerify({
  label: "xai",
  textModel: bundle.text!,
  imageModel: bundle.image!,
  routes: [{ config: bundle.config, model: bundle.image!.model }],
});
