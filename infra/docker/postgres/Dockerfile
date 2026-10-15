# PostgreSQL 17 + PostGIS 3.5 (official image) + pgvector built from a pinned, checksummed release.
# DECISION(BF-002): Alpine variant + source build — the Debian `17-3.5` tag is still on bullseye, whose PGDG
# apt repository (source of the postgresql-17-pgvector package) has been retired.
# Contrib extensions (pg_trgm, unaccent, ltree, citext) ship with PostgreSQL itself.
FROM postgis/postgis:17-3.5-alpine@sha256:894f570c0cf0664ed5576a8fd5d5bfb8fb1b19d592885b686c3a88c8bd90c41f

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

COPY init/ /docker-entrypoint-initdb.d/

HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=10 \
  CMD pg_isready -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" || exit 1
