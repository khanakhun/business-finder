# Rolling back (BF-061)

A rollback starts the previous release again: its own compose file and its pinned images, on the current schema
(migrations are forward-only and expand-only, so the previous release still works on it). Target: **< 10 minutes**.

## Automatic

- The health gate fails during `deploy.sh` → the previous release is started again; the workflow fails.
- The post-deploy smoke test fails → the workflow runs `ssh production rollback`; it fails.

Either way, read the workflow log (state only: container logs stay on the server) and the alerts, then fix forward.

## By hand

- **From GitHub**: run *deploy-production* with the previous version (approval as usual). Use this when the
  previous release is no longer on the server (only the current and previous ones are kept).
- **On the server** (as the deploy user, in `/opt/bf`): `./rollback.sh` (to `IMAGE_TAG.previous`) or
  `./rollback.sh v1.3.2` (any release still in `releases/`).

A rollback does not record the release it left as the next rollback target: rolling back twice does not bring the
bad release back.

## When a rollback is not enough

- A migration broke data (not just code): restore to a timestamp — [restore.md](restore.md) (BF-061 part 2).
- The previous release fails too: the problem is outside the release (database, disk, provider) — see the alert's
  runbook and `docker compose ps` / `docker compose logs <service>` on the server.

After any rollback: open an incident note (what, when, impact, cause), keep the failed release's tag (do not
delete it), and ship the fix as a new release.
