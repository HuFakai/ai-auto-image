import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Auth and PGlite-backed billing integration tests are intentionally end-to-end.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
