# syntax=docker/dockerfile:1
# The sandbox egress proxy (BF-043): HTTPS CONNECT to allowlisted hosts only. Build from the repository root:
#   docker build -f services/egress-proxy/Dockerfile -t bf-egress-proxy .
# DECISION(BF-043): a small in-house CONNECT proxy instead of smokescreen (no maintained image) or Squid (ACLs, but
# no per-host denial metrics without a log pipeline); see ADR-0010's addendum.

ARG NODE_IMAGE=node:24.13.1-trixie-slim@sha256:1c78323e27e7aff8ac92377845119cd52ac3d3b22e197b3b14e8eb64af387f8c

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @bf/egress-proxy... \
 && pnpm --filter @bf/egress-proxy build

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build /repo/services/egress-proxy/dist/egress-proxy.mjs /opt/egress-proxy.mjs
USER node
ENV EGRESS_PORT=4750 EGRESS_METRICS_PORT=9465 EGRESS_PROFILE=models
EXPOSE 4750 9465
ENTRYPOINT ["node", "/opt/egress-proxy.mjs"]
