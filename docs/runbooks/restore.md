# Backups and restore (BF-061)

**Targets: RPO ≤ 5 minutes, RTO ≤ 2 hours**, measured monthly by the restore drill.

## 1. What is backed up

| What | How | Where | Kept |
|---|---|---|---|
| Postgres, continuously | WAL archiving: `archive_command = pgbackrest-spool %p %f` copies each finished segment (at least one a minute, `archive_timeout=60`) into the `wal-spool` volume; the `pgbackrest` service pushes it to both repositories every 5 s | repo1 + repo2 | with the backups that need it |
| Postgres, base backups | the `pgbackrest` service (`bf-pgbackrest schedule`): full nightly at `BACKUP_AT`, incremental every `BACKUP_INCR_HOURS` (6) | repo1 (PITR) | 30 days (`repo1-retention-full-type=time`) |
| Postgres, monthly | full on the 1st | repo2 | 12 (`repo2-retention-full=12`) |
| Postgres, logical | `pg_dump` nightly (the `backup` service, BF-025) — handy to restore one table | its own prefix | `BACKUP_RETENTION_DAYS` |
| Object storage (assets, artifacts) | bucket versioning + lifecycle: non-current versions expire after 30 days | the provider | 30 days of history |
| Valkey | AOF (`appendfsync everysec`) on its volume; treated as rebuildable (§5) | the host | — |
| Master key (secrets vault) | offline escrow (§6) | two people | — |

Postgres never reaches object storage itself: it has no route out and no key. The `pgbackrest` service holds the
repository keys and reads the data directory read-only. Both repositories are encrypted by pgBackRest
(`aes-256-cbc`) before anything leaves the host; **the cipher passphrases are in the password manager — without them
no backup can be restored.**

### `pgbackrest.env` (mode 600 in `/opt/bf`; pgBackRest reads `PGBACKREST_*` options from the environment)

```
PGBACKREST_REPO1_TYPE=s3                    PGBACKREST_REPO2_TYPE=s3
PGBACKREST_REPO1_PATH=/pgbackrest           PGBACKREST_REPO2_PATH=/pgbackrest-monthly
PGBACKREST_REPO1_S3_BUCKET=<backups bucket> PGBACKREST_REPO2_S3_BUCKET=<backups bucket, or a second provider>
PGBACKREST_REPO1_S3_ENDPOINT=<host>         PGBACKREST_REPO2_S3_ENDPOINT=<host>
PGBACKREST_REPO1_S3_REGION=<region>         PGBACKREST_REPO2_S3_REGION=<region>
PGBACKREST_REPO1_S3_KEY=…                   PGBACKREST_REPO2_S3_KEY=…
PGBACKREST_REPO1_S3_KEY_SECRET=…            PGBACKREST_REPO2_S3_KEY_SECRET=…
PGBACKREST_REPO1_S3_URI_STYLE=path          PGBACKREST_REPO2_S3_URI_STYLE=path
PGBACKREST_REPO1_CIPHER_TYPE=aes-256-cbc    PGBACKREST_REPO2_CIPHER_TYPE=aes-256-cbc
PGBACKREST_REPO1_CIPHER_PASS=…              PGBACKREST_REPO2_CIPHER_PASS=…
PGBACKREST_REPO1_RETENTION_FULL_TYPE=time   PGBACKREST_REPO2_RETENTION_FULL=12
PGBACKREST_REPO1_RETENTION_FULL=30          PGBACKREST_REPO2_RETENTION_ARCHIVE_TYPE=full
                                            PGBACKREST_REPO2_RETENTION_ARCHIVE=1
BACKUP_AT=03:00   BACKUP_INCR_HOURS=6
```

In `.env`: `PG_ARCHIVE_MODE=on` and `COMPOSE_PROFILES=pitr` (starts the `pgbackrest` service). Changing
`PG_ARCHIVE_MODE` restarts Postgres. The bucket holds backups only, in its own account or with its own keys; put repo2
at a second provider or region for an off-site copy.

## 2. Monitoring

The `pgbackrest` service writes `bf_pgbackrest.prom` (node_exporter textfile collector, part 3) every 5 minutes:
`bf_backup_last_success_timestamp_seconds{repo,type}`, `bf_backup_last_size_bytes`, `bf_backup_stanza_ok`,
`bf_wal_spool_files`, `bf_wal_last_push_timestamp_seconds`, `bf_restore_drill_last_success_timestamp_seconds`,
`bf_restore_drill_rto_seconds`. Alerts: last full backup older than 26 h; WAL not pushed for 15 min while the spool
is not empty; stanza not OK; no successful drill for 35 days. By hand: `docker compose exec pgbackrest bf-pgbackrest
info`.

## 3. The restore drill

`.github/workflows/restore-drill.yml`, on the 3rd of every month (and on demand, optionally to a point in time):
`infra/backup/drill/restore-drill.sh` restores into a throwaway server on the CI runner, replays the WAL until it
promotes, and runs `infra/backup/drill/checks.sql` (migrations at head, PostGIS and pgvector load, workspaces and
users present, every table scans). The report (RTO, RPO, counts) is the job summary and `drills/latest.json` in
repo1. The drill server never archives (`archive_mode=off`): it cannot write into the production repository.

Run it by hand on any Docker host the same way (the script's header lists the variables). A local rehearsal with a
posix repository in a volume took 15 s to promote and found the row written after the last full backup (WAL replay).

## 4. Restoring production

Decide first: **the latest state** (lost disk, broken host) or **a point in time** (a bad migration, a mass delete:
just before it). Note the time from the audit log or the application logs, in UTC.

1. Stop the writers: `docker compose stop api worker sites pgbackrest backup` (Caddy answers 502; the renderer is
   down too — say so on the status page).
2. Stop Postgres and keep its data aside: `docker compose stop postgres`, then move the volume's content (or
   `docker volume create bf_postgres-data-restore` and point the service at it for the restore).
3. Restore (as uid 70, with the repositories' settings, the data volume mounted **read-write** — the `pgbackrest`
   service mounts it read-only, so use a one-off container on the same image):
   ```
   docker run --rm --user 70:70 --env-file pgbackrest.env --env PGBACKREST_STANZA=bf \
     --volume bf_postgres-data:/var/lib/postgresql/data --entrypoint pgbackrest \
     "$(docker compose images --format json postgres | jq -r '.[0].Repository + ":" + .[0].Tag')" \
     --pg1-path=/var/lib/postgresql/data restore --delta \
     [--type=time --target='2026-10-17 09:29:00+00' --target-action=promote]
   ```
   (`--delta` reuses matching files of the existing directory; without the old data, restore into an empty volume.)
4. `docker compose up -d postgres` — it replays the WAL and promotes (watch `docker compose logs -f postgres`).
5. Check: `infra/backup/drill/checks.sql` against it, and the thing that went wrong is right.
6. `docker compose up -d` (everything else), run the smoke test, then **take a full backup right away**
   (`docker compose exec pgbackrest bf-pgbackrest full`): a promoted server starts a new timeline.

After a point-in-time restore, the writes after the target are gone (outbound messages sent in that window are in the
mailbox providers' sent folders, not in the database): note the window in the incident report.

## 5. Valkey lost

Valkey holds queues, caches, rate-limit counters, view counters and locks — all rebuildable:

- Durable work lives in Postgres state machines and the transactional outbox (BF-012): undelivered events are
  re-published by the outbox relay; outbound messages (BF-052) are claimed by the minute tick from their `queued`
  rows; scheduled jobs (sweeps, flushes) re-register on worker start.
- Lost: at most 5 minutes of site view counts (flushed every 5 minutes), in-flight job attempts (retried from their
  rows), rate-limit windows (reset).
- No duplicate sends: each send is reconciled against the provider by its idempotency key before any retry (BF-052).

Recovery: `docker compose up -d valkey` (an empty volume is fine), then restart `worker` and `api`. Check the queues'
depth in the dashboard return to normal within 15 minutes.

## 6. Master key escrow

The secrets vault's master key (`SECRETS_MASTER_KEY`) decrypts every stored provider key and mailbox
credential; the database backups are useless for them without it. Escrow: printed (or on an encrypted USB key) in
two sealed envelopes held by two different people, never in the same place as the backups' passphrases. Rotation:
[secrets-rotation.md](secrets-rotation.md). Check the escrow once a year (open, compare the fingerprint, reseal).
