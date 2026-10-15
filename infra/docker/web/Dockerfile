# syntax=docker/dockerfile:1
# apps/web image: the Next.js standalone server (BF-025). Build from the repository root:
#   docker build -f infra/docker/web/Dockerfile -t bf-web .
# No URL is baked in: NEXT_PUBLIC_API_URL, NEXT_PUBLIC_APP_URL and NEXT_PUBLIC_MAP_STYLE_URL are read when the
# server starts (src/lib/public-env.ts), so the same image runs in staging and production.

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
RUN pnpm dlx "turbo@${TURBO_VERSION}" prune @bf/web --docker

FROM base AS build
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
# Standalone output traces the server's files into .next/standalone (next.config.ts, NEXT_OUTPUT).
ENV NODE_ENV=production \
    NEXT_OUTPUT=standalone
RUN pnpm --filter @bf/web build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=root:root /repo/apps/web/.next/standalone/ ./
COPY --from=build --chown=root:root /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=root:root /repo/apps/web/public ./apps/web/public
# The only writable path: Next's data and image cache. The code itself stays root-owned (read-only to the server).
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health/ready`).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
