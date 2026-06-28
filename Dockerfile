# syntax=docker/dockerfile:1
#
# ForgeFX — Node backend (Fastify + fractal-midi). Multi-arch: the official node images are
# amd64 + arm64, so this builds natively on a Raspberry Pi 4/5 too.
#
# Build context is the repo root (so `vendor/` and `definitions/` are available).

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY vendor ./vendor
COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
COPY vendor ./vendor
COPY definitions ./definitions
COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist ./dist
ENV NODE_ENV=production \
    PORT=5056 \
    FORGEFX_DEFINITIONS=/app/definitions
EXPOSE 5056
# the FM3 is passed through to the container at a stable path (see docker-compose.yml)
CMD ["node", "dist/index.js"]
