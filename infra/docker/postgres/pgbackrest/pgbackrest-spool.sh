#!/bin/sh
# archive_command of the production database (BF-061): `pgbackrest-spool %p %f`. Copies a finished WAL segment into
# the spool the `pgbackrest` service pushes to the repositories (Postgres itself has no route out and no storage key).
# Atomic (copy, then rename) and never overwrites: an existing segment fails the call, as Postgres requires. The
# name says pgbackrest on purpose: pgBackRest's `check` and `backup` verify that archive_command goes through it.
set -eu
spool="${PGBACKREST_SPOOL_DIR:-/wal-spool}"
[ ! -f "$spool/$2" ] || exit 1
cp "$1" "$spool/$2.tmp"
mv "$spool/$2.tmp" "$spool/$2"
