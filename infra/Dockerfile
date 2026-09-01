# 多阶段构建：不包含源码缓存、测试工具、Chromium 与开发依赖
FROM node:22-alpine AS build
WORKDIR /repo
RUN apk add --no-cache bash curl
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=1235 \
    DATA_DIR=/data \
    ASSETS_DIR=/data/assets \
    EXPORTS_DIR=/data/exports \
    SQLITE_MIGRATIONS_DIR=/app/drizzle

COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/packages/storage/drizzle ./drizzle
RUN addgroup -S aai && adduser -S aai -G aai \
  && mkdir -p /data/db /data/assets /data/exports \
  && chown -R aai:aai /data /app
USER aai
VOLUME ["/data"]
EXPOSE 1235

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||1235)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
