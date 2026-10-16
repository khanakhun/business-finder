# syntax=docker/dockerfile:1
# services/intel image. Build from the repository root:
#   docker build -f infra/docker/intel/Dockerfile -t bf-intel .
#   docker build -f infra/docker/intel/Dockerfile --build-arg INSTALL_BROWSERS=false -t bf-intel:slim .
# DECISION(BF-008): python:3.13-slim + `playwright install --with-deps chromium` rather than the official
# Playwright image, whose Python is the distro's (3.12 on noble, 3.14 on resolute) — the service pins 3.13.

# Pinned by digest (multi-arch index) so a rebuilt tag cannot change the image silently; Renovate bumps both.
ARG PYTHON_IMAGE=python:3.13.13-slim-trixie@sha256:aa938a849bcb82dce8f49480f056ab82bf5c1c3ebc294f0430f37b6820e7f286

FROM ghcr.io/astral-sh/uv:0.10.12@sha256:72ab0aeb448090480ccabb99fb5f52b0dc3c71923bffb5e2e26517a1c27b7fec AS uv

FROM ${PYTHON_IMAGE} AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
# Dependencies first: this layer is reused until pyproject.toml/uv.lock change.
COPY services/intel/pyproject.toml services/intel/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project
COPY services/intel/app ./app
RUN python -m compileall -q app

FROM ${PYTHON_IMAGE} AS runtime
ARG INSTALL_BROWSERS=true
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    INTEL_HOST=0.0.0.0 \
    INTEL_PORT=8000
RUN groupadd --system --gid 10001 intel \
    && useradd --system --uid 10001 --gid intel --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin intel
COPY --from=build /opt/venv /opt/venv
# Chromium and its system libraries (as root, before dropping privileges). Skip with INSTALL_BROWSERS=false.
RUN if [ "$INSTALL_BROWSERS" = "true" ]; then \
      playwright install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/*; \
    fi
# DuckDB httpfs bundled at build time (no extension download at runtime) and a writable extract cache.
ENV OPEN_DATA_EXTENSION_DIR=/opt/duckdb-extensions \
    OPEN_DATA_CACHE_DIR=/var/cache/bf-intel/open-data
RUN python -c "import duckdb; duckdb.connect(config={'extension_directory': '/opt/duckdb-extensions'}).execute('INSTALL httpfs')" \
    && mkdir -p /var/cache/bf-intel && chown 10001:10001 /var/cache/bf-intel
WORKDIR /app
COPY --from=build /src/app ./app
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ['INTEL_PORT']}/health/ready\", timeout=2)"]
# Workers come from INTEL_WORKERS (app/serve.py); prefer more replicas over more workers.
CMD ["python", "-m", "app.serve"]
