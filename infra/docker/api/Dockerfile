# syntax=docker/dockerfile:1
# apps/api image: HTTP API, worker, migrations and admin CLIs from one image (BF-025). Build from the repository root:
#   docker build -f infra/docker/api/Dockerfile -t bf-api .
# Run: `http` (default), `worker`, `migrate`, or a package script such as `admin:bootstrap -- --email …`.
# The API runs its TypeScript through @swc-node/register (as in development): no separate build output to drift.

ARG NODE_IMAGE=node:24.13.1-trixie-slim@sha256:1c78323e27e7aff8ac92377845119cd52ac3d3b22e197b3b14e8eb64af387f8c
ARG TURBO_VERSION=2.11.8

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Only what @bf/api depends on: its workspace packages and a lockfile cut down to them.
FROM base AS prune
ARG TURBO_VERSION
COPY . .
RUN pnpm dlx "turbo@${TURBO_VERSION}" prune @bf/api --docker

# Production dependencies only (no dev tooling in the runtime image). The dependency layer is cached until the
# pruned manifests change.
FROM base AS install
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    API_PORT=4000 \
    WORKER_METRICS_PORT=9464
WORKDIR /repo
COPY --from=install --chown=root:root /repo/ ./
COPY --from=prune --chown=root:root /repo/out/full/ ./
COPY --chmod=0755 infra/docker/api/entrypoint.sh /usr/local/bin/bf-api
# Writable scratch for the app (exports, temp files); everything else stays read-only to the runtime user.
RUN mkdir -p /tmp/bf && chown node:node /tmp/bf
USER node
WORKDIR /repo/apps/api
EXPOSE 4000 9464
# The HTTP role's liveness; compose gives the worker its own (metrics port) and disables it for one-shot jobs.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.API_PORT}/health/live`).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["bf-api"]
CMD ["http"]
