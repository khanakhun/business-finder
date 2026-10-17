-- Restore drill integrity checks (BF-061, infra/backup/drill/restore-drill.sh). Run on the restored, promoted
-- server; any failure raises and fails the drill. The expected migration count comes from the repository's journal
-- (PGOPTIONS='-c bf.expected_migrations=<n>').
\set ON_ERROR_STOP on

-- Migrations at head: the restored schema is the one the release expects.
DO $$
DECLARE applied int; expected int := current_setting('bf.expected_migrations')::int;
BEGIN
  SELECT count(*) INTO applied FROM drizzle.__drizzle_migrations;
  IF applied < expected THEN
    RAISE EXCEPTION 'migrations behind: % applied, % in the repository', applied, expected;
  END IF;
END $$;

-- The extensions the schema depends on load.
SELECT postgis_version() IS NOT NULL AS postgis, '[1,2,3]'::vector IS NOT NULL AS pgvector;

-- Core data is there and readable (an empty production would mean the wrong backup).
DO $$
BEGIN
  IF (SELECT count(*) FROM organizations) = 0 THEN RAISE EXCEPTION 'no workspace in the restored database'; END IF;
  IF (SELECT count(*) FROM users) = 0 THEN RAISE EXCEPTION 'no user in the restored database'; END IF;
END $$;

-- Every table can be scanned (catches unreadable pages); reports approximate sizes.
DO $$
DECLARE t record; n bigint;
BEGIN
  FOR t IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public', 'drizzle') LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', t.schemaname, t.tablename) INTO n;
  END LOOP;
END $$;

-- The report's numbers.
SELECT
  (SELECT count(*) FROM drizzle.__drizzle_migrations) AS migrations,
  (SELECT count(*) FROM organizations) AS workspaces,
  (SELECT count(*) FROM businesses) AS businesses,
  (SELECT count(*) FROM sites) AS sites,
  extract(epoch FROM now() - pg_last_xact_replay_timestamp())::int AS rpo_seconds;
