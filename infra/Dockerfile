# 多阶段构建：不包含源码缓存、测试工具、Chromium 与开发依赖
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# 字体已在仓库上下文中（.gitignore 仅影响 Git，不影响 Docker 上下文）
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    SQLITE_PATH=/data/db/app.db \
    ASSETS_DIR=/data/assets \
    EXPORTS_DIR=/data/exports \
    SQLITE_MIGRATIONS_DIR=/app/drizzle \
    FONT_DIR=/app/fonts \
    IMAGE_GENERATION_CONCURRENCY_DEFAULT=1 \
    IMAGE_GENERATION_CONCURRENCY_MAX=4 \
    IMAGE_POSTPROCESS_CONCURRENCY_MAX=1

COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/packages/storage/drizzle ./drizzle
COPY --from=build /repo/packages/render-engine/assets/fonts ./fonts

RUN addgroup -S aai && adduser -S aai -G aai \
  && mkdir -p /data/db /data/assets /data/exports \
  && chown -R aai:aai /data /app
USER aai
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
