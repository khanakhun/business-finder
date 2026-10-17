# PostgreSQL 17 + PostGIS 3.5 (official image) + pgvector built from a pinned, checksummed release.
# DECISION(BF-002): Alpine variant + source build — the Debian `17-3.5` tag is still on bullseye, whose PGDG
# apt repository (source of the postgresql-17-pgvector package) has been retired.
# Contrib extensions (pg_trgm, unaccent, ltree, citext) ship with PostgreSQL itself.
# BF-061: pgBackRest (PITR: WAL archiving from this container, scheduled backups from the `pgbackrest` service on the
# same image), built from its pinned, checksummed release against this image's libpq.
ARG BASE_IMAGE=postgis/postgis:17-3.5-alpine@sha256:894f570c0cf0664ed5576a8fd5d5bfb8fb1b19d592885b686c3a88c8bd90c41f

FROM ${BASE_IMAGE} AS pgbackrest
ARG PGBACKREST_VERSION=2.59.2
ARG PGBACKREST_SHA256=03c2ac7056d3924fc1152ba63c0b35876f5a8399950f930c77f88491e04f235d
RUN apk add --no-cache build-base meson pkgconf openssl-dev libxml2-dev lz4-dev zstd-dev bzip2-dev zlib-dev yaml-dev \
  && wget -q -O /tmp/pgbackrest.tar.gz \
    "https://github.com/pgbackrest/pgbackrest/archive/release/${PGBACKREST_VERSION}.tar.gz" \
  && echo "${PGBACKREST_SHA256}  /tmp/pgbackrest.tar.gz" | sha256sum -c - \
  && mkdir /tmp/pgbackrest && tar -xzf /tmp/pgbackrest.tar.gz -C /tmp/pgbackrest --strip-components=1 \
  && PKG_CONFIG_PATH=/usr/local/lib/pkgconfig meson setup /tmp/build /tmp/pgbackrest \
    -Dlibssh2=disabled -Dlibsystemd=disabled \
  && ninja -C /tmp/build \
  && install -m 0755 /tmp/build/src/pgbackrest /usr/local/bin/pgbackrest

FROM ${BASE_IMAGE}

ARG PGVECTOR_VERSION=0.8.7
ARG PGVECTOR_SHA256=cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85

# OPTFLAGS="" keeps the build portable (pgvector defaults to -march=native); with_llvm=no skips JIT bitcode,
# which would need clang/llvm in the image for no benefit at our data sizes.
RUN apk add --no-cache --virtual .build-deps build-base \
  && wget -q -O /tmp/pgvector.tar.gz "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
  && echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c - \
  && mkdir /tmp/pgvector && tar -xzf /tmp/pgvector.tar.gz -C /tmp/pgvector --strip-components=1 \
  && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no \
  && make -C /tmp/pgvector install with_llvm=no \
  && rm -rf /tmp/pgvector /tmp/pgvector.tar.gz \
  && apk del .build-deps

# pgBackRest's runtime libraries, the binary, and the backup service's scheduler (bf-pgbackrest).
RUN apk add --no-cache lz4-libs zstd-libs libxml2 yaml libbz2 zlib libssl3 jq
COPY --from=pgbackrest /usr/local/bin/pgbackrest /usr/local/bin/pgbackrest
# Plain COPY + chmod: the integration tests build this image with Docker's classic builder (no --chmod).
COPY pgbackrest/bf-pgbackrest.sh /usr/local/bin/bf-pgbackrest
COPY pgbackrest/pgbackrest-spool.sh /usr/local/bin/pgbackrest-spool
RUN chmod 0755 /usr/local/bin/bf-pgbackrest /usr/local/bin/pgbackrest-spool
# Named volumes mounted here start with these owners: the WAL spool (written by archive_command, emptied by the
# pgbackrest service) and node_exporter's textfile directory.
RUN install -d -o postgres -g postgres -m 0700 /wal-spool \
  && install -d -o postgres -g postgres -m 0755 /textfile

COPY init/ /docker-entrypoint-initdb.d/

HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=10 \
  CMD pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" || exit 1
