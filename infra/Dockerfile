# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/ai-core/package.json packages/ai-core/
COPY packages/shared-schemas/package.json packages/shared-schemas/
COPY packages/provider-openai/package.json packages/provider-openai/
COPY packages/provider-xai/package.json packages/provider-xai/
COPY packages/provider-compatible/package.json packages/provider-compatible/
COPY packages/workflow-engine/package.json packages/workflow-engine/
COPY packages/render-engine/package.json packages/render-engine/
RUN pnpm install --frozen-lockfile=false
COPY . .
RUN pnpm --filter @aai/web build

# ---- runtime stage: no Chromium, no dev deps, no source ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    SQLITE_PATH=/data/app.db \
    FONT_REGULAR_PATH=/app/fonts/NotoSansSC-Regular.otf \
    FONT_BOLD_PATH=/app/fonts/NotoSansSC-Bold.otf

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/packages/render-engine/assets/fonts ./fonts

RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown -R app:app /data /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "apps/web/server.js"]
