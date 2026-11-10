# syntax=docker/dockerfile:1.7
# Alpha — production image (Express API + built React SPA, SQLite on the /data volume).
# Build:  docker build -t alpha-platform .
# Run:    see deploy/compose.yaml and docs/deployment.md

ARG NODE_VERSION=24
# Static docker CLI used by the sandbox module to reach a REMOTE daemon (ALPHA_SANDBOX_DOCKER_HOST); no daemon in this image.
ARG DOCKER_CLI_IMAGE=docker:29-cli

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

# ---------- 1. full dependency tree (needed for the Vite build and for tsx) ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------- 2. front-end build ----------
FROM deps AS build
COPY . .
# Type checking runs in CI (`npm run build` = tsc --noEmit && vite build); the image only needs the bundle.
RUN npx vite build \
 && mkdir -p sandbox

# ---------- 3. production dependencies + the TypeScript runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund
# The server runs its TypeScript sources through tsx (a devDependency whose only dependency is esbuild).
COPY --from=deps /app/node_modules/tsx ./node_modules/tsx
COPY --from=deps /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=deps /app/node_modules/@esbuild ./node_modules/@esbuild
RUN ln -sf ../tsx/dist/cli.mjs node_modules/.bin/tsx \
 && node --import tsx -e "import('node:sqlite').then(() => console.log('tsx + node:sqlite OK'))"

# ---------- 4. runtime ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG ALPHA_VERSION=0.4.0
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Alpha" \
      org.opencontainers.image.description="Plateforme francophone de collaboration tech (Express + SQLite + React)" \
      org.opencontainers.image.version="${ALPHA_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="UNLICENSED"

# tini reaps zombies (tar/gzip children of the backup job) and forwards SIGTERM to Node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATABASE_PATH=/data/alpha.sqlite \
    FILES_DIR=/data/files \
    BACKUP_DIR=/data/backups \
    ALPHA_SANDBOX_WORK_DIR=/data/sandbox-work \
    NPM_CONFIG_CACHE=/tmp/.npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/sandbox ./sandbox
COPY --chown=root:root package.json package-lock.json tsconfig.json ./
COPY --chown=root:root server ./server
COPY --chown=root:root scripts ./scripts
# Legal texts served by the privacy module (LEGAL_DOCS_DIR can point elsewhere, e.g. a lawyer-validated version).
COPY --chown=root:root docs/legal ./docs/legal

# Application code stays root-owned (read-only for the app user); only /data is writable.
RUN mkdir -p /data/files /data/backups && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/system/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts"]
