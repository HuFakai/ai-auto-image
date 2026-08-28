import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@aai/shared-schemas": path.resolve(__dirname, "../../packages/shared-schemas/src/index.ts"),
      "@aai/ai-core": path.resolve(__dirname, "../../packages/ai-core/src/index.ts"),
      "@aai/workflow-engine": path.resolve(__dirname, "../../packages/workflow-engine/src/index.ts"),
      "@aai/render-engine": path.resolve(__dirname, "../../packages/render-engine/src/index.ts"),
      "@aai/provider-openai": path.resolve(__dirname, "../../packages/provider-openai/src/index.ts"),
      "@aai/provider-xai": path.resolve(__dirname, "../../packages/provider-xai/src/index.ts"),
      "@aai/provider-compatible": path.resolve(__dirname, "../../packages/provider-compatible/src/index.ts"),
    },
  },
  define: {
    "process.env.NEXT_RUNTIME": JSON.stringify("nodejs"),
  },
});
