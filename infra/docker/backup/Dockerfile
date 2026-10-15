# syntax=docker/dockerfile:1
# Staging backups (BF-025): nightly `pg_dump` (custom format) to S3-compatible storage with retention, plus list and
# restore commands. Production-grade PITR is BF-061. Build: docker build -t bf-backup infra/docker/backup
# pg_dump must be at least the server's major version: same Postgres 17 as infra/docker/postgres.
ARG POSTGRES_IMAGE=postgres:17-trixie@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3

FROM ${POSTGRES_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends rclone ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 backup.sh /usr/local/bin/bf-backup
USER postgres
WORKDIR /tmp
ENTRYPOINT ["bf-backup"]
CMD ["schedule"]
