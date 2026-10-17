# Game day (BF-061)

Three failures, rehearsed on a staging clone before production carries real traffic, then once a quarter. Record
each run in the table at the end (date, who, result, time to recover, follow-ups).

## 1. Valkey lost

1. During a send window, with messages queued and a generation running:
   `docker compose -p bf stop valkey && docker volume rm bf_valkey-data && docker compose -p bf up -d valkey`.
2. Restart `worker` and `api`.
3. Expect: queues refill from the database (outbox relay, the outreach tick's `queued` rows, worker-scheduled
   sweeps); `CriticalQueueBacklog` may fire briefly and clears; **no message sent twice** (check the outbox: one
   provider message id per message) and none lost (every `queued` message ends `sent`, `failed` or `blocked`).
4. Measure: time until the queues dashboard is back to normal.

## 2. A bad deploy

1. Tag a release whose API fails its readiness (e.g. a staging build with a required setting missing).
2. Deploy it with *deploy-production* (on the staging clone).
3. Expect: the health gate fails, `deploy.sh` starts the previous release again, the workflow fails; the renderer
   serves throughout (watch the canary probe: no failures). Then a release that passes the gate but fails the smoke
   test: the workflow rolls back (`ssh … rollback`).
4. Measure: time from the start of the deploy to the previous release serving (target < 10 min); probe errors during
   the rollout (target: 0 for the renderer, ≤ 0.1% for API/web).

## 3. Restore to a timestamp

1. Note the time, then delete something recoverable (a test workspace's businesses).
2. Follow [restore.md](restore.md) §4 with `--type=time --target=<the noted time>`.
3. Expect: the deleted rows are back, `checks.sql` passes, a full backup runs after.
4. Measure: RTO (target ≤ 2 h) and the data window lost (target ≤ 5 min).

## Results

| Date | Scenario | Where | Result | Recovery | Follow-ups |
|---|---|---|---|---|---|
| 2026-10-17 | Restore (latest state, PITR replay) | local rehearsal: posix repository, `bf-postgres` image with pgBackRest 2.59.2, real migrations | **Pass** — a row written after the full backup came back through WAL replay; `checks.sql` passed (68 migrations) | 15 s to promotion | run against the S3 repository in CI (the monthly drill) |
| — | Valkey lost | staging clone | pending (needs the staging clone) | — | — |
| — | Bad deploy → automatic rollback | staging clone | pending (needs the `production` environment on a staging clone) | — | — |
| — | Restore to a timestamp | staging clone | pending | — | — |
