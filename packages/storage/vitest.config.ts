import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // PGlite 首次启动/执行迁移在冷环境可能超过 Vitest 默认 5 秒。
    // 这是集成测试合理的单测门禁，不依赖调用方额外传参。
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
