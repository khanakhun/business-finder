#!/usr/bin/env bash
# Restore drill (BF-061, docs/runbooks/restore.md): restores the latest backup (or a point in time) from the
# pgBackRest repository into a throwaway server, replays the WAL, waits for promotion, runs the integrity checks and
# reports the recovery time (RTO) and data age (RPO). Runs monthly in CI (.github/workflows/restore-drill.yml) and by
# hand on any Docker host — the same steps as a real restore, minus pointing the application at it.
#
#   IMAGE=ghcr.io/<owner>/bf-postgres:<tag> EXPECTED_MIGRATIONS=67 [TARGET_TIME='2026-10-17 09:30:00+00'] \
#     PGBACKREST_REPO1_…=… ./restore-drill.sh [report.json]
#
# The repository settings come from PGBACKREST_* variables (read access is enough). The restored server never
# archives (archive_mode=off): a drill cannot write into the production repository. DRILL_DOCKER_ARGS adds docker
# options to both containers (a network, or a volume holding a posix repository for a local rehearsal).
set -euo pipefail

: "${IMAGE:?IMAGE (the bf-postgres image) is required}"
: "${EXPECTED_MIGRATIONS:?EXPECTED_MIGRATIONS is required}"
report="${1:-restore-drill.json}"
name="bf-drill-$$"
volume="${name}-data"
rto_limit="${RTO_LIMIT_SECONDS:-7200}"
here="$(cd "$(dirname "$0")" && pwd)"

log() { printf '[drill %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
cleanup() {
  docker rm --force "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The PGBACKREST_* settings, passed by name only (values never appear on a command line).
env_args=()
while IFS='=' read -r key _; do env_args+=(--env "$key"); done < <(env | grep -E '^PGBACKREST_[A-Z0-9_]+=' || true)
env_args+=(--env PGBACKREST_STANZA="${PGBACKREST_STANZA:-bf}" --env PGBACKREST_LOG_PATH=/tmp
  --env PGBACKREST_LOCK_PATH=/tmp/pgbackrest --env PGBACKREST_LOG_LEVEL_FILE=off)

# shellcheck disable=SC2206 # docker options, split on spaces on purpose
extra=(${DRILL_DOCKER_ARGS:-})
target=()
if [ -n "${TARGET_TIME:-}" ]; then
  target=(--type=time "--target=${TARGET_TIME}" --target-action=promote)
fi

started=$(date -u +%s)
log "restoring ${TARGET_TIME:-the latest state} with ${IMAGE}"
docker volume create "$volume" >/dev/null
# The image's data directory is owned by postgres (uid 70): the new volume takes that ownership.
docker run --rm --user 70:70 "${env_args[@]}" "${extra[@]}" --volume "$volume:/var/lib/postgresql/data" \
  --entrypoint pgbackrest "$IMAGE" \
  --pg1-path=/var/lib/postgresql/data --archive-mode=off "${target[@]}" restore

log "starting the restored server (WAL replay)"
docker run --detach --name "$name" --user 70:70 "${env_args[@]}" "${extra[@]}" \
  --volume "$volume:/var/lib/postgresql/data" "$IMAGE" postgres -c archive_mode=off >/dev/null

# Promotion ends the replay: the server accepts writes. Bounded by the RTO.
until docker exec "$name" psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -tAc \
  'SELECT NOT pg_is_in_recovery()' 2>/dev/null | grep -qx t; do
  if [ $(($(date -u +%s) - started)) -gt "$rto_limit" ]; then
    log "not promoted within ${rto_limit} s"
    docker logs --tail 50 "$name" 2>&1 | grep -E 'LOG|FATAL|ERROR' | tail -20 || true
    exit 1
  fi
  sleep 5
done
promoted=$(date -u +%s)
rto=$((promoted - started))
log "promoted after ${rto} s; running the checks"

result="$(docker exec --env PGOPTIONS="-c bf.expected_migrations=${EXPECTED_MIGRATIONS}" --interactive "$name" \
  psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" --no-psqlrc -q -tA -F ' ' \
  < "$here/checks.sql" | tail -n 1)"
read -r migrations workspaces businesses sites rpo <<<"$result"
finished=$(date -u +%s)

cat > "$report" <<JSON
{"finishedAt": $finished, "rtoSeconds": $rto, "rpoSeconds": ${rpo:-null}, "targetTime": "${TARGET_TIME:-latest}",
 "migrations": $migrations, "workspaces": $workspaces, "businesses": $businesses, "sites": $sites}
JSON
log "ok: RTO ${rto} s, RPO ${rpo:-?} s, ${migrations} migrations, ${workspaces} workspaces, ${businesses} businesses"
cat "$report"
