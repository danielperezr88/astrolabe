# Astrolabe Docker Image (#273)
# Multi-stage build for minimal production image.
# Usage:
#   docker build -t astrolabe .
#   docker run -p 4747:4747 -v $(pwd):/workspace astrolabe serve

FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/shared/package.json packages/shared/

RUN npm ci --ignore-scripts

COPY . .
RUN npm run build --workspace packages/core --if-present || true
RUN npm run build --workspace packages/cli --if-present || true

FROM node:20-alpine

RUN apk add --no-cache git tree-sitter

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./

ENV ASTROLABE_API_KEY=""
ENV NODE_ENV=production

EXPOSE 4747

# Default: start HTTP server
CMD ["npx", "astrolabe", "serve", "--host", "0.0.0.0"]
