# syntax=docker/dockerfile:1
# The agent runner (BF-043): the sandbox generation agents run in. A supervisor (PID 1 under tini) reads the run's
# input and workspace on stdin and answers with frames on stdout (@bf/contracts/runner). Build from the repository root:
#   docker build -f services/agent-runner/Dockerfile -t bf-agent-runner .
# DECISION(BF-043): same digest-pinned Debian trixie Node base as the API image (the ticket named bookworm; one base
# to patch and scan instead of two).

ARG NODE_IMAGE=node:24.13.1-trixie-slim@sha256:1c78323e27e7aff8ac92377845119cd52ac3d3b22e197b3b14e8eb64af387f8c
ARG TURBO_VERSION=2.11.8
ARG CLAUDE_CODE_VERSION=2.1.288
ARG CODEX_VERSION=0.160.0
ARG PLAYWRIGHT_VERSION=1.64.1
ARG LIGHTHOUSE_VERSION=13.5.0
ARG AXE_PLAYWRIGHT_VERSION=4.13.0

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS prune
ARG TURBO_VERSION
COPY . .
RUN pnpm dlx "turbo@${TURBO_VERSION}" prune @bf/agent-runner --docker

# The block library's stylesheet and fonts, the sitekit bundle (BF-042) and the supervisor bundle.
FROM base AS build
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ .
RUN pnpm --filter @bf/site-blocks build \
 && pnpm --filter @bf/sitekit build \
 && pnpm --filter @bf/agent-runner build

FROM ${NODE_IMAGE} AS runtime
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
ARG PLAYWRIGHT_VERSION
ARG LIGHTHOUSE_VERSION
ARG AXE_PLAYWRIGHT_VERSION
ARG RUNNER_VERSION=dev
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# The base's Debian packages are upgraded at build time: security fixes land without waiting for a new Node image.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends tini ripgrep git jq zstd ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The coding CLIs, pinned (npm is the documented install for containers of both), and sitekit's browser.
RUN npm install --global --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force
WORKDIR /opt/sitekit
COPY --from=build /repo/packages/sitekit/dist/ ./
# sitekit's browser and its audits (BF-045: axe-core and Lighthouse, external to the bundle), pinned.
RUN npm install --no-audit --no-save "playwright@${PLAYWRIGHT_VERSION}" \
      "lighthouse@${LIGHTHOUSE_VERSION}" "@axe-core/playwright@${AXE_PLAYWRIGHT_VERSION}" \
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && npm cache clean --force \
 && node -e "const fs=require('fs');const p=require('playwright').chromium.executablePath();fs.writeFileSync('/opt/sitekit/chromium-version',p.split('/').find(s=>s.startsWith('chromium'))||'chromium')" \
 && printf '#!/bin/sh\nexec node /opt/sitekit/sitekit.mjs "$@"\n' > /usr/local/bin/sitekit \
 && chmod 0755 /usr/local/bin/sitekit \
 # The package managers are build tools: not in the sandbox (less to patch, nothing for an agent to install with).
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /root/.npm

COPY --from=build /repo/services/agent-runner/dist/ /opt/runner/

RUN groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --home-dir /home/agent --no-create-home --shell /usr/sbin/nologin agent \
 && mkdir -p /workspace /home/agent \
 && chown agent:agent /workspace /home/agent

# Quiet, pinned CLIs: no auto-update, telemetry, error reports or other non-essential traffic (Claude Code env vars;
# Codex reads ~/.codex/config.toml, seeded from /opt/runner/home at start).
ENV HOME=/home/agent \
    NODE_OPTIONS=--max-old-space-size=2048 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    BF_RUNNER_VERSION=${RUNNER_VERSION}

LABEL org.opencontainers.image.title="bf-agent-runner" \
      org.opencontainers.image.description="Business Finder agent runner: supervisor, Claude Code, Codex, sitekit, Chromium" \
      org.opencontainers.image.source="https://github.com/khanakhun/business-finder" \
      org.opencontainers.image.licenses="UNLICENSED" \
      bf.runner.versions="{\"claude-code\":\"${CLAUDE_CODE_VERSION}\",\"codex\":\"${CODEX_VERSION}\",\"playwright\":\"${PLAYWRIGHT_VERSION}\",\"lighthouse\":\"${LIGHTHOUSE_VERSION}\",\"runner\":\"${RUNNER_VERSION}\"}"

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/runner/supervisor.mjs"]
