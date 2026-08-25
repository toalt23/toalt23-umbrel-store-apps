# Build-Stage
FROM node:22-alpine AS builder

# node-gyp build deps for the equihashverify native addon (Equihash solution
# verification for the stratum pool) — python3/make/g++ for node-gyp itself,
# libsodium-dev/boost-dev because equihashverify's binding.gyp links against them.
RUN apk add --no-cache python3 make g++ libsodium-dev boost-dev

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production-Stage
FROM node:22-alpine

# Same native-build deps as the builder stage: `npm ci` below recompiles
# equihashverify's native addon here too (not copied from the builder stage),
# so these are needed at runtime-image build time, not just for `nest build`.
# su-exec: lets the entrypoint start as root (to fix bind-mount ownership,
# see docker-entrypoint.sh) and then drop to the unprivileged `node` user
# before running the actual app.
RUN apk add --no-cache python3 make g++ libsodium-dev boost-dev su-exec

WORKDIR /app

COPY package*.json ./
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