FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HYPERFRAMES_NO_TELEMETRY=1 \
    HYPERFRAMES_BROWSER_PATH=/usr/local/bin/hyperframes-chrome \
    HYPERFRAMES_RENDERER_HOST=0.0.0.0 \
    HYPERFRAMES_RENDERER_PORT=8788 \
    HYPERFRAMES_PROJECTS_ROOT=/app \
    HYPERFRAMES_RUNTIME_DIR=/app/data/hyperframes-runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        fonts-noto-cjk \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libgtk-3-0 \
        libnss3 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        procps \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/services/hyperframes-renderer

COPY package.json package-lock.json ./
RUN npm ci --include=dev \
    && npx hyperframes browser ensure \
    && ln -s "$(npx hyperframes browser path)" "$HYPERFRAMES_BROWSER_PATH" \
    && npm cache clean --force

COPY scripts ./scripts
COPY fixtures ./fixtures

RUN npm ci --prefix fixtures/stickman-psychology \
    && mkdir -p /app/data/hyperframes-runtime /app/output \
    && node --check scripts/server.mjs \
    && npm run check

EXPOSE 8788

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/server.mjs"]
