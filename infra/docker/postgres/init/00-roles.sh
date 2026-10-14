#!/bin/sh
# Runs once, on first start of an empty data directory (docker-entrypoint-initdb.d).
# DECISION(BF-002): a shell script rather than 00-roles.sql, because the password comes from the environment.
#
# bf_sites_ro: read-only login used by apps/sites (AGENTS.md §3). It can read every table the owner creates in
# `public`, now or later (default privileges), and every transaction it opens is read-only even if a grant is
# added by mistake. Migrations (BF-003) run as POSTGRES_USER, the owner of all objects.
set -eu

: "${BF_SITES_RO_PASSWORD:?BF_SITES_RO_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v ro_password="$BF_SITES_RO_PASSWORD" -v db="$POSTGRES_DB" -v owner="$POSTGRES_USER" <<'SQL'
CREATE ROLE bf_sites_ro LOGIN PASSWORD :'ro_password';
ALTER ROLE bf_sites_ro SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE :"db" TO bf_sites_ro;
GRANT USAGE ON SCHEMA public TO bf_sites_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO bf_sites_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO bf_sites_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT ON TABLES TO bf_sites_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT ON SEQUENCES TO bf_sites_ro;
SQL
