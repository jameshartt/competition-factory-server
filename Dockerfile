# Build stage
FROM node:24-alpine AS builder

ENV CI=true
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY audit-worker/package.json audit-worker/pnpm-workspace.yaml audit-worker/.npmrc ./audit-worker/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# Production stage
FROM node:24-alpine

ENV CI=true
RUN corepack enable && apk add --no-cache curl

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY audit-worker/package.json audit-worker/pnpm-workspace.yaml audit-worker/.npmrc ./audit-worker/

# Install all deps (compression is needed at runtime but lives in devDependencies)
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY --from=builder /app/build ./build

# Postgres migration-runner reads SQL files at runtime from src/storage/postgres/migrations.
# Copy just that subtree so we keep the production image small.
COPY --from=builder /app/src/storage/postgres/migrations ./src/storage/postgres/migrations

# The i18n module serves manifest + locale overlays from ./i18n at runtime;
# sync-i18n.mjs generates that directory during the builder's pnpm build.
COPY --from=builder /app/i18n ./i18n

RUN mkdir -p /app/data /app/cache && chown -R node:node /app

USER node

EXPOSE 8383

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:8383/ || exit 1

CMD ["node", "build/src/main.js"]
