#!/bin/sh
# bf-pgbackrest: point-in-time recovery backups of the production database with pgBackRest (BF-061,
# docs/runbooks/restore.md). Runs as the `pgbackrest` compose service on the bf-postgres image, as the postgres user
# (uid 70), with the data directory mounted read-only and the server's socket shared. The postgres container has no
# route out and no storage key: its archive_command copies each finished WAL segment into /wal-spool, and this
# service pushes them (pgbackrest archive-push, which checks each segment against the cluster) and removes them.
#
#   schedule   forever: the WAL spool every 5 s (a background loop); a full backup every night at BACKUP_AT (UTC), an incremental every
#              BACKUP_INCR_HOURS, a full backup into the monthly repository on the 1st; metrics every 5 minutes
#   full | incr | monthly   one backup now
#   metrics    write the Prometheus textfile (backup ages, sizes, the last restore drill) and exit
#   info       pgBackRest's view of the repositories
#
# Repositories (pgBackRest reads its settings from PGBACKREST_* variables, pgbackrest.env):
#   repo1  the PITR repository: nightly fulls and incrementals, 30 days (repo1-retention-full-type=time)
#   repo2  monthly fulls, 12 kept (repo2-retention-full=12); WAL is archived to both
# Both are encrypted by pgBackRest (aes-256-cbc, PGBACKREST_REPO<n>_CIPHER_PASS) before anything leaves the host.
set -eu

export PGBACKREST_STANZA="${PGBACKREST_STANZA:-bf}"
export PGBACKREST_LOG_PATH="${PGBACKREST_LOG_PATH:-/tmp}"
export PGBACKREST_LOCK_PATH="${PGBACKREST_LOCK_PATH:-/tmp/pgbackrest}"
export PGBACKREST_LOG_LEVEL_FILE="${PGBACKREST_LOG_LEVEL_FILE:-off}"
export PGBACKREST_LOG_LEVEL_CONSOLE="${PGBACKREST_LOG_LEVEL_CONSOLE:-info}"
BACKUP_AT="${BACKUP_AT:-03:00}"
BACKUP_INCR_HOURS="${BACKUP_INCR_HOURS:-6}"
TEXTFILE_DIR="${TEXTFILE_DIR:-/textfile}"
SPOOL_DIR="${SPOOL_DIR:-/wal-spool}"

log() { printf '{"time":"%s","service":"bf-pgbackrest","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Idempotent: creates the stanza on first run, checks it on the next ones.
ensure_stanza() {
  pgbackrest stanza-create >/dev/null 2>&1 || pgbackrest stanza-upgrade >/dev/null 2>&1 || true
  pgbackrest check
}

backup() {
  type="$1"
  repo="${2:-1}"
  log "backup ${type} to repo${repo} started"
  pgbackrest --repo="$repo" --type="$type" backup
  log "backup ${type} to repo${repo} done"
  # Expiry needs the delete permission this service's key has (the archive key does not).
  pgbackrest --repo="$repo" expire
}

# Pushes the spooled WAL segments in order; a failure leaves the rest for the next pass (Postgres keeps the WAL it
# could not hand over in pg_wal, and the spool, until then). Partial copies (*.tmp) are Postgres's in-flight writes.
drain_spool() {
  for file in $(ls "$SPOOL_DIR" 2>/dev/null | grep -v '\.tmp$' | sort); do
    if pgbackrest archive-push "$SPOOL_DIR/$file" >/dev/null; then
      rm -f "$SPOOL_DIR/$file"
      date -u +%s > /tmp/bf-last-push
    else
      log "archive-push failed for ${file}"
      return 1
    fi
  done
}

# Prometheus textfile for node_exporter (BF-061 alerts: backup age > 26 h, drill older than 35 days).
metrics() {
  [ -d "$TEXTFILE_DIR" ] || return 0
  tmp="$TEXTFILE_DIR/.bf_pgbackrest.prom.$$"
  info="$(pgbackrest --output=json info 2>/dev/null || echo '[]')"
  {
    echo '# HELP bf_backup_last_success_timestamp_seconds When the last backup of a type finished, per repository.'
    echo '# TYPE bf_backup_last_success_timestamp_seconds gauge'
    printf '%s' "$info" | jq -r '
      .[0].backup // [] | group_by([.database["repo-key"], .type])[] | max_by(.timestamp.stop)
      | "bf_backup_last_success_timestamp_seconds{repo=\"\(.database["repo-key"])\",type=\"\(.type)\"} \(.timestamp.stop)"'
    echo '# HELP bf_backup_last_size_bytes Repository size of the last backup of a type.'
    echo '# TYPE bf_backup_last_size_bytes gauge'
    printf '%s' "$info" | jq -r '
      .[0].backup // [] | group_by([.database["repo-key"], .type])[] | max_by(.timestamp.stop)
      | "bf_backup_last_size_bytes{repo=\"\(.database["repo-key"])\",type=\"\(.type)\"} \(.info.repository.delta)"'
    echo '# HELP bf_backup_stanza_ok 1 when pgBackRest reports the stanza healthy.'
    echo '# TYPE bf_backup_stanza_ok gauge'
    printf '%s' "$info" | jq -r '"bf_backup_stanza_ok \(if (.[0].status.code // 99) == 0 then 1 else 0 end)"'
    # The monthly restore drill (.github/workflows/restore-drill.yml) leaves its result in repo1 (not encrypted).
    drill="$(pgbackrest --repo=1 repo-get --raw drills/latest.json 2>/dev/null || true)"
    [ -n "$drill" ] || drill='{}'
    echo '# HELP bf_restore_drill_last_success_timestamp_seconds When the last successful restore drill finished.'
    echo '# TYPE bf_restore_drill_last_success_timestamp_seconds gauge'
    printf '%s' "$drill" | jq -r '"bf_restore_drill_last_success_timestamp_seconds \(.finishedAt // 0)"' \
      2>/dev/null || echo 'bf_restore_drill_last_success_timestamp_seconds 0'
    echo '# HELP bf_restore_drill_rto_seconds How long the last drill took from an empty disk to a promoted server.'
    echo '# TYPE bf_restore_drill_rto_seconds gauge'
    printf '%s' "$drill" | jq -r '"bf_restore_drill_rto_seconds \(.rtoSeconds // 0)"' 2>/dev/null || true
    echo '# HELP bf_wal_spool_files WAL segments waiting in the spool (archiving lag).'
    echo '# TYPE bf_wal_spool_files gauge'
    echo "bf_wal_spool_files $(ls "$SPOOL_DIR" 2>/dev/null | grep -vc '\.tmp$' || true)"
    echo '# HELP bf_wal_last_push_timestamp_seconds When a WAL segment last reached the repositories.'
    echo '# TYPE bf_wal_last_push_timestamp_seconds gauge'
    echo "bf_wal_last_push_timestamp_seconds $(cat /tmp/bf-last-push 2>/dev/null || echo 0)"
    echo '# HELP bf_pgbackrest_metrics_timestamp_seconds When these metrics were written.'
    echo '# TYPE bf_pgbackrest_metrics_timestamp_seconds gauge'
    echo "bf_pgbackrest_metrics_timestamp_seconds $(date -u +%s)"
  } > "$tmp"
  mv "$tmp" "$TEXTFILE_DIR/bf_pgbackrest.prom"
}

case "${1:-schedule}" in
  schedule)
    # The spool drains in its own loop: `check` and every backup wait for their WAL segments to reach the
    # repository, which only this drainer puts there.
    (while true; do drain_spool || true; sleep 5; done) &
    ensure_stanza
    log "scheduled: full daily at ${BACKUP_AT} UTC, incremental every ${BACKUP_INCR_HOURS} h, monthly on the 1st"
    # A first full backup right away when there is none (incrementals need one).
    pgbackrest --repo=1 info --output=json | jq -e '.[0].backup | length > 0' >/dev/null 2>&1 \
      || "$0" full || log "initial full backup failed"
    metrics || true
    last_incr=$(date -u +%s)
    last_minute=''
    last_metrics=0
    while true; do
      sleep 10
      now=$(date -u +%s)
      hhmm=$(date -u +%H:%M)
      # Backups at most once per minute (the loop wakes every 10 s).
      [ "$hhmm" != "$last_minute" ] || continue
      last_minute=$hhmm
      if [ "$hhmm" = "$BACKUP_AT" ]; then
        # Its own process: `set -e` stops a failing run at its first error, the schedule goes on.
        "$0" full || log "full backup failed"
        [ "$(date -u +%d)" = 01 ] && { "$0" monthly || log "monthly backup failed"; }
        last_incr=$now
      elif [ $((now - last_incr)) -ge $((BACKUP_INCR_HOURS * 3600)) ]; then
        "$0" incr || log "incremental backup failed"
        last_incr=$now
      fi
      if [ $((now - last_metrics)) -ge 300 ]; then
        metrics || log "metrics failed"
        last_metrics=$now
      fi
    done
    ;;
  full) backup full 1 && metrics ;;
  incr) backup incr 1 && metrics ;;
  monthly) backup full 2 && metrics ;;
  metrics) metrics ;;
  drain) drain_spool ;;
  info) pgbackrest info ;;
  *)
    echo "usage: bf-pgbackrest [schedule|full|incr|monthly|metrics|info]" >&2
    exit 64
    ;;
esac
