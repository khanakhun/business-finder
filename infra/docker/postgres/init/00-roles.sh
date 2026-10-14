#!/bin/sh
# Runs once, on first start of an empty data directory (docker-entrypoint-initdb.d).
# DECISION(BF-002): a shell script rather than 00-roles.sql, because the password comes from the environment.
#
# bf_sites_ro: read-only login used by apps/sites (AGENTS.md §3). ADR-0004 limits it to the publication/version
# tables, so it gets no table privileges here: the migration that creates those tables (BF-035) grants SELECT on
# exactly them. Every transaction it opens is read-only even if a broader grant is added by mistake.
# Migrations (BF-003) run as POSTGRES_USER, the owner of all objects.
set -eu

: "${BF_SITES_RO_PASSWORD:?BF_SITES_RO_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v ro_password="$BF_SITES_RO_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE bf_sites_ro LOGIN PASSWORD :'ro_password';
ALTER ROLE bf_sites_ro SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE :"db" TO bf_sites_ro;
GRANT USAGE ON SCHEMA public TO bf_sites_ro;
SQL
