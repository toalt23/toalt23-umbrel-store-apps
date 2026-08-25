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
RUN apk add --no-cache python3 make g++ libsodium-dev boost-dev

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

EXPOSE 3000
# Stratum (mining) TCP port — see POOL_STRATUM_PORT.
EXPOSE 3333

CMD ["node", "dist/main"]