# syntax=docker/dockerfile:1
#
# ForgeFX — Node backend (Fastify + forgefx-midi). Multi-arch: the official node images are
# amd64 + arm64, so this builds natively on a Raspberry Pi 4/5 too.
#
# Build context is the repo root and MUST contain a `forgefx-midi/` copy of the sibling
# codec repo (the server's package.json links it as `file:../../forgefx-midi`, which from
# /app/server resolves to /forgefx-midi in-image). CI stages it with rsync; locally:
#   rsync -a --exclude node_modules --exclude .git ../forgefx-midi/ ./forgefx-midi/
#   docker build -t forgefx .
# (docker-compose.yml documents the same prerequisite.)

FROM node:20-bookworm-slim AS build
# the codec package first: its exports point at dist/, so build it in-image
COPY forgefx-midi /forgefx-midi
WORKDIR /forgefx-midi
RUN npm ci && npm run build && npm prune --omit=dev && npm cache clean --force
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
WORKDIR /app/server
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
# the built codec at the exact path the server's file: link resolves to (no node_modules —
# forgefx-midi has zero runtime deps; dist/ + catalog/ + package.json are what imports need)
COPY --from=build /forgefx-midi/package.json /forgefx-midi/package.json
COPY --from=build /forgefx-midi/dist /forgefx-midi/dist
COPY --from=build /forgefx-midi/catalog /forgefx-midi/catalog
WORKDIR /app
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
