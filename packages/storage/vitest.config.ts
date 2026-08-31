import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 多个文件同时冷启动 PGlite 会争抢 WASM/迁移资源；文件级串行可避免门禁抖动。
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
