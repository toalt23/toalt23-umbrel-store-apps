# Build-Stage
FROM node:22-alpine AS builder

WORKDIR /app

# `npm ci` needs the "equihash-verify-wasm" local file: dependency
# (wasm/equihash-verify/pkg) present already, so COPY everything up front
# here rather than package*.json first — no native compile step left to
# make caching that split worth the complexity (see wasm/equihash-verify/
# for how that prebuilt WASM artifact is produced; it's committed, not
# built by this Dockerfile).
COPY . .
RUN npm ci
RUN npm run build

# Production-Stage
FROM node:22-alpine

# su-exec: lets the entrypoint start as root (to fix bind-mount ownership,
# see docker-entrypoint.sh) and then drop to the unprivileged `node` user
# before running the actual app.
RUN apk add --no-cache su-exec

WORKDIR /app

COPY package*.json ./
COPY --from=builder /app/wasm ./wasm
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
# Stratum (mining) TCP port — see POOL_STRATUM_PORT.
EXPOSE 3333

# No USER directive here on purpose — the container must start as root so
# the entrypoint can fix up the pool-config bind mount's ownership. It drops
# to the unprivileged `node` user itself before exec'ing the app (see
# docker-entrypoint.sh). docker-compose.yml must NOT set `user: "1000:1000"`
# on this service, or the container never gets to be root in the first place.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main"]
