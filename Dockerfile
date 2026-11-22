# Bundle image of competition-factory-server for jim-dot-tennis (see BUNDLE.md).
# Build with bundle/build.sh, which supplies the build arguments below.

ARG NODE_IMAGE=node:26-alpine

# ---------------------------------------------------------------- base
# Node 25+ no longer ships corepack, so install it, then let it fetch the pnpm
# version package.json declares (packageManager).
FROM ${NODE_IMAGE} AS base
ENV CI=true SCARF_ANALYTICS=false
RUN npm install -g corepack@0.36.0 && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Bundle guard: refuse link: overrides before anything is installed.
COPY bundle/check-links.mjs bundle/
RUN node bundle/check-links.mjs && corepack install

# ---------------------------------------------------------------- build
FROM base AS builder
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# nest build copies the migration SQL into build/src/storage/postgres/migrations
# (nest-cli.json assets); sync-i18n writes ./i18n from @courthive/i18n. Both are
# read at runtime, so fail here if either is missing.
RUN pnpm build \
 && node src/scripts/sync-i18n.mjs \
 && test -f build/src/main.js \
 && test -f build/src/storage/postgres/migrations/001-initial-schema.sql \
 && test -f i18n/manifest.json

# ---------------------------------------------------------------- runtime deps
FROM base AS proddeps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production

COPY --from=proddeps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=builder /app/build ./build
COPY --from=builder /app/i18n ./i18n
# Upstream's admin script, run once per instance to create the first superadmin:
#   node src/scripts/admin-user.mjs create -e <email> -p <password>
COPY --from=builder /app/src/scripts/admin-user.mjs ./src/scripts/admin-user.mjs

# Licences, NOTICE and the licences of the installed third-party packages.
ARG VERSION
ARG UPSTREAM_VERSION
ARG UPSTREAM_COMMIT
ARG UPSTREAM_REPO
ARG FORK_REPO
ARG FORK_COMMIT
COPY LICENSE bundle/third-party-licenses.mjs /tmp/bundle/
RUN set -eu; \
    for v in VERSION UPSTREAM_VERSION UPSTREAM_COMMIT UPSTREAM_REPO FORK_REPO FORK_COMMIT; do \
      eval "val=\${$v:-}"; [ -n "$val" ] || { echo "build argument $v is required (use bundle/build.sh)"; exit 1; }; \
    done; \
    mkdir -p /licenses; \
    cp /tmp/bundle/LICENSE /licenses/LICENSE-competition-factory-server; \
    node /tmp/bundle/third-party-licenses.mjs --node-modules /app /licenses/THIRD-PARTY-LICENSES.txt; \
    printf '%s\n' \
      "CourtHive competition-factory-server, image version $VERSION." \
      "" \
      "Built from a fork of the CourtHive repository $UPSTREAM_REPO" \
      "at upstream commit $UPSTREAM_COMMIT (upstream version $UPSTREAM_VERSION)," \
      "with the changes listed in BUNDLE.md of the fork $FORK_REPO" \
      "at commit $FORK_COMMIT." \
      "" \
      "This is not an official CourtHive build. The server is MIT licensed;" \
      "see LICENSE-competition-factory-server." \
      "Third-party packages installed in the image: THIRD-PARTY-LICENSES.txt." \
      > /licenses/NOTICE; \
    rm -rf /tmp/bundle
LABEL org.opencontainers.image.title="courthive-server" \
      org.opencontainers.image.description="CourtHive competition-factory-server for the jim-dot-tennis bundle; not an official CourtHive build" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$FORK_COMMIT" \
      org.opencontainers.image.source="$FORK_REPO" \
      org.opencontainers.image.licenses="MIT" \
      jdt.upstream.source="$UPSTREAM_REPO" \
      jdt.upstream.commit="$UPSTREAM_COMMIT" \
      jdt.upstream.version="$UPSTREAM_VERSION"

# Writable paths: ARCHIVES_PATH falls back to ./.archives-local.
RUN mkdir -p /app/.archives-local && chown node:node /app/.archives-local
USER node

EXPOSE 8383
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||8383)+'/factory/version').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "build/src/main.js"]
