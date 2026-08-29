/** OpenAI 真实调用验证：OPENAI_API_KEY=sk-... pnpm verify:openai */
import { loadDotEnv } from "./lib/env";
import { requireKey, runVerify } from "./lib/verify";
import { createOpenAICompatProvider, createWireClient, openaiRoute } from "@aai/provider-openai";

loadDotEnv();
const apiKey = requireKey("OPENAI_API_KEY");

const config = openaiRoute();
const bundle = createOpenAICompatProvider({
  config,
  apiKey,
  client: createWireClient(config, apiKey),
});

await runVerify({
  label: "openai",
  textModel: bundle.text!,
  imageModel: bundle.image!,
  routes: [{ config, model: bundle.image!.model }],
});
