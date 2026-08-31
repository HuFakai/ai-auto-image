import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Cold PGlite/font/render setup can exceed Vitest's default under parallel runs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
