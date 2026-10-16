#!/bin/sh
# bf-backup: logical backups of the staging database to S3-compatible storage (BF-025).
#   schedule        run `backup` every day at BACKUP_AT (UTC, HH:MM), forever (the compose service)
#   backup          dump now, upload, then delete dumps older than BACKUP_RETENTION_DAYS
#   list            list stored dumps
#   restore <name> --into <database>   restore into another (existing, empty) database on the same server
#   restore <name> --overwrite-live    restore over the live database (pg_restore --clean): stop writers first
#
# Dumps are encrypted before they leave the host (rclone crypt, BACKUP_ENCRYPTION_PASSPHRASE): the bucket only ever
# holds ciphertext. Keep the passphrase in the password manager too — without it no dump can be restored.
#
# Environment: DATABASE_URL, BACKUP_ENCRYPTION_PASSPHRASE, BACKUP_S3_ENDPOINT, BACKUP_S3_REGION, BACKUP_S3_BUCKET,
# BACKUP_S3_PREFIX, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY, BACKUP_AT (03:00),
# BACKUP_RETENTION_DAYS (14).
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
: "${BACKUP_S3_ACCESS_KEY_ID:?BACKUP_S3_ACCESS_KEY_ID is required}"
: "${BACKUP_S3_SECRET_ACCESS_KEY:?BACKUP_S3_SECRET_ACCESS_KEY is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"
BACKUP_AT="${BACKUP_AT:-03:00}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-staging/postgres}"

# rclone reads its remote from the environment: no config file, nothing written to disk.
export RCLONE_CONFIG_STORE_TYPE=s3
export RCLONE_CONFIG_STORE_PROVIDER=Other
export RCLONE_CONFIG_STORE_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
export RCLONE_CONFIG_STORE_REGION="${BACKUP_S3_REGION:-us-east-1}"
export RCLONE_CONFIG_STORE_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
export RCLONE_CONFIG_STORE_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_STORE_NO_CHECK_BUCKET=true
# Encryption layer over the bucket (file names stay readable: they carry only the date).
export RCLONE_CONFIG_SEALED_TYPE=crypt
export RCLONE_CONFIG_SEALED_REMOTE="store:${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}"
export RCLONE_CONFIG_SEALED_FILENAME_ENCRYPTION=off
export RCLONE_CONFIG_SEALED_DIRECTORY_NAME_ENCRYPTION=false
RCLONE_CONFIG_SEALED_PASSWORD="$(rclone obscure "$BACKUP_ENCRYPTION_PASSPHRASE")"
export RCLONE_CONFIG_SEALED_PASSWORD
remote="sealed:"

# JSON lines; messages are this script's own words (no quotes or backslashes to escape).
log() { printf '{"time":"%s","service":"bf-backup","msg":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

backup() {
  name="bf-$(date -u +%Y%m%dT%H%M%SZ).dump"
  file="/tmp/$name"
  log "dump started"
  pg_dump --format=custom --compress=6 --no-owner --file="$file" "$DATABASE_URL"
  rclone copyto "$file" "$remote/$name"
  rm -f "$file"
  log "uploaded $name"
  # Only after a successful upload, and only dumps of this job.
  rclone delete --min-age "${BACKUP_RETENTION_DAYS}d" --include 'bf-*.dump' "$remote"
  log "retention applied (${BACKUP_RETENTION_DAYS} days)"
}

seconds_until() {
  now=$(date -u +%s)
  target=$(date -u -d "today $1" +%s)
  [ "$target" -le "$now" ] && target=$(date -u -d "tomorrow $1" +%s)
  echo $((target - now))
}

case "${1:-schedule}" in
  schedule)
    log "scheduled daily at ${BACKUP_AT} UTC"
    while true; do
      sleep "$(seconds_until "$BACKUP_AT")"
      # Its own process, so `set -e` stops a failing night at the first error (a function on the left of `||` would
      # run with errexit off). Logged and retried the next day; the service keeps running.
      "$0" backup || log "backup failed"
    done
    ;;
  backup) backup ;;
  list) rclone lsl "$remote" ;;
  restore)
    name="${2:?usage: restore <name> --into <database> | --overwrite-live (see list)}"
    case "${3:-}" in
      --into)
        database="${4:?--into needs a database name}"
        printf '%s' "$database" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]{0,62}$' || { echo "invalid database name" >&2; exit 64; }
        # Same server and credentials, another database (the last path segment of the URL).
        target_url="$(printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]+(\?|$)#/${database}\1#")"
        ;;
      --overwrite-live)
        target_url="$DATABASE_URL"
        ;;
      *)
        echo "restore needs --into <database> or --overwrite-live" >&2
        exit 64
        ;;
    esac
    rclone copyto "$remote/$name" "/tmp/$name"
    log "restoring $name"
    # All or nothing: an error rolls the whole restore back instead of leaving a half-dropped database.
    pg_restore --clean --if-exists --no-owner --exit-on-error --single-transaction \
      --dbname="$target_url" "/tmp/$name"
    rm -f "/tmp/$name"
    log "restored $name"
    ;;
  *)
    echo "usage: bf-backup [schedule|backup|list|restore <name> --into <db>|--overwrite-live]" >&2
    exit 64
    ;;
esac
