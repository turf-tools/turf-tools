# Web image. Build from the repo root:
#   docker build -f apps/web/Dockerfile -t turf-tools-web .
FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app

# The root `prepare` script runs `vp config`, which shells out to git.
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# `VITE_*` is inlined into the client bundle at build time, so it has to be a
# build arg rather than a runtime env var. Shared across deployments.
ARG VITE_MAPTILER_KEY=""

COPY . .

# `--filter web...` pulls in web plus its workspace deps (db, utils) and skips
# native's Expo tree entirely.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter web...
RUN VITE_MAPTILER_KEY=$VITE_MAPTILER_KEY pnpm -F web build

# Nitro bundles the server and its dependencies into .output, so the runtime
# stage needs neither node_modules nor pnpm.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/apps/web/.output ./.output

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
