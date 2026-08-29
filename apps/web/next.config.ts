import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // 固定 monorepo 根（apps/web 的上两级），保证 standalone 目录结构可预测（Docker COPY 依赖此布局）
  outputFileTracingRoot: path.resolve(process.cwd(), "..", ".."),
  // 原生模块不打包，运行时直接 require（必须在 web 中同时声明为直接依赖，
  // 否则 pnpm 布局下运行时 require 无法解析到平台二进制）
  serverExternalPackages: ["better-sqlite3", "sharp", "@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"],
  transpilePackages: [
    "@aai/ai-core",
    "@aai/provider-compatible",
    "@aai/provider-mock",
    "@aai/provider-openai",
    "@aai/provider-xai",
    "@aai/render-engine",
    "@aai/shared-schemas",
    "@aai/storage",
    "@aai/workflow-engine",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // 双保险：强制原生模块走 commonjs externals，避免被打进 vendor chunk
      config.externals = [...config.externals, { sharp: "commonjs sharp", "better-sqlite3": "commonjs better-sqlite3" }];
    }
    return config;
  },
};

export default nextConfig;
