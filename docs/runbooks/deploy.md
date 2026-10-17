# Releasing and deploying (BF-061)

## Release

1. Merge PRs to `main` with Conventional Commit titles (the merge commit subject is what the changelog reads).
2. `release.yml` keeps a **release PR** open ("chore(main): release x.y.z") with the next version and the
   `CHANGELOG.md` entries (feat → minor, fix → patch; before 1.0.0, breaking changes bump the minor).
3. Merging the release PR tags `vX.Y.Z` and creates the GitHub Release. The same workflow then pins that commit's
   images: CI already built them for the commit (sha tag, SBOM, provenance); it resolves each application image's
   digest, tags it `vX.Y.Z` too, and attaches **`release.env`** (`BF_<NAME>_IMAGE=ghcr.io/…@sha256:…`).
4. A hotfix: tag a commit of `main` by hand (`git tag v1.4.1 <sha> && git push origin v1.4.1`); the pinning runs on
   the pushed tag.

Signing (cosign) and signature verification at deploy are BF-060's and arrive with it; until then the digests pin
the exact bytes CI tested.

## Deploy

Actions → **deploy-production** → *Run workflow* on `main` with the version (`v1.4.0`). A required reviewer of the
`production` environment approves; then the job:

1. checks the version is a tag on `main` and downloads its `release.env` (digest references only);
2. uploads the compose file, `deploy.sh` and the seccomp profile **from main**, and `release.env`, to
   `/opt/bf/releases/v1.4.0/`;
3. runs `deploy.sh v1.4.0` on the server:
   - pulls the pinned images, runs the migrations (`migrate` one-shot, expand-only — see below);
   - rolls **api** and **sites** out side by side: a second replica starts with the new image, Caddy sends it
     traffic once `/health/live` passes, the old replica gets SIGTERM and 35 s to finish (SSE clients reconnect);
   - updates everything else in place (web, worker — BullMQ waits for active jobs up to 45 s — intel, caddy);
   - health gate through Caddy (`api` and `app` `/health/ready`, a sites 404): on failure it starts the previous
     release again and the job fails;
4. runs `scripts/smoke-prod.mjs` from outside (readiness, sign-in page, the release in `/v1/system/info`, the
   unsubscribe host, the canary preview). **A failed smoke test rolls back** (`ssh production rollback`).

The web container (fixed address on the edge network) restarts in place: a few seconds of dashboard requests may
fail (the renderer and the API do not). Expect a deploy to take 3–6 minutes.

## Migrations: expand/contract

The migrations run while the previous release still serves, and a rollback runs it again on the migrated schema.
So a release may only *add*: new tables, new nullable columns (or with a default), new indexes (concurrently, in
their own migration), new views. `pnpm check:migrations` (CI, `db` job) refuses drops, renames, type changes,
`SET NOT NULL` and `NOT NULL` columns without a default.

To remove or reshape something: release N stops using it (and writes both shapes if needed), release N+1 carries
the contract migration with a line `-- bf:contract <why it is safe now>` — reviewed like code, and only once N is
the oldest release a rollback could reach.

## Staging

Unchanged (BF-025): every green `main` build deploys to staging by sha (`deploy-staging.yml`). Staging is where a
release candidate has already run before it is tagged.
