import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: [
    "@aai/ai-core",
    "@aai/provider-compatible",
    "@aai/provider-openai",
    "@aai/provider-xai",
    "@aai/render-engine",
    "@aai/shared-schemas",
    "@aai/workflow-engine",
  ],
  serverExternalPackages: ["better-sqlite3", "sharp"],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
