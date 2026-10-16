# syntax=docker/dockerfile:1
# apps/sites image: the site renderer's Next.js standalone server (BF-036). Build from the repository root:
#   docker build -f infra/docker/sites/Dockerfile -t bf-sites .
# Nothing is baked in: the read-only database URL, the two shared secrets, API_URL and SITES_BASE_DOMAIN are read
# when the server starts (src/lib/env.ts), so the same image runs in staging and production.

ARG NODE_IMAGE=node:24.13.1-trixie-slim@sha256:1c78323e27e7aff8ac92377845119cd52ac3d3b22e197b3b14e8eb64af387f8c
ARG TURBO_VERSION=2.11.8

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS prune
ARG TURBO_VERSION
COPY . .
RUN pnpm dlx "turbo@${TURBO_VERSION}" prune @bf/sites --docker

FROM base AS build
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
# Standalone output traces the server's files into .next/standalone (next.config.ts, NEXT_OUTPUT). The block
# library's stylesheet and fonts are built first; the build reads no database (a placeholder URL passes the env check).
ENV NODE_ENV=production \
    NEXT_OUTPUT=standalone
RUN pnpm --filter @bf/site-blocks build \
 && SITES_DATABASE_URL=postgres://build:build@127.0.0.1:5432/build pnpm --filter @bf/sites build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=root:root /repo/apps/sites/.next/standalone/ ./
COPY --from=build --chown=root:root /repo/apps/sites/.next/static ./apps/sites/.next/static
# The block library's stylesheet and fonts, copied into public/_bf by the build (scripts/next.mjs).
COPY --from=build --chown=root:root /repo/apps/sites/public ./apps/sites/public
# The only writable path: Next's cache. The code itself stays root-owned (read-only to the server).
RUN mkdir -p apps/sites/.next/cache && chown node:node apps/sites/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health/ready`).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/sites/server.js"]
