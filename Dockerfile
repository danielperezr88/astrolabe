# Astrolabe Docker Image (#273)
# Multi-stage build for minimal production image.
# Uses node:20-slim (Debian) instead of Alpine because better-sqlite3
# prebuilt binaries are linked against glibc and will not load on musl.
#
# Usage:
#   docker build -t astrolabe .
#   docker run -p 4747:4747 -v $(pwd):/workspace astrolabe serve

# ---- Builder stage: install deps + compile TypeScript ----
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only package manifests first for better layer caching
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/shared/package.json packages/shared/
COPY scripts/postinstall.mjs scripts/

RUN npm ci --ignore-scripts
# Download the correct better-sqlite3 prebuilt binary for this platform
RUN node scripts/postinstall.mjs

# Copy source and build in dependency order: shared → core → cli
COPY . .
RUN npm run build --workspace packages/shared
RUN npm run build --workspace packages/core
RUN npm run build --workspace packages/cli

# ---- Production stage: minimal runtime image ----
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./

# #349: Security — run as non-root user
RUN groupadd --system astrolabe && useradd --system --gid astrolabe astrolabe
RUN chown -R astrolabe:astrolabe /app
USER astrolabe

ENV NODE_ENV=production

EXPOSE 4747

# Default: start HTTP server
CMD ["node", "packages/cli/dist/index.js", "serve", "--host", "0.0.0.0"]
