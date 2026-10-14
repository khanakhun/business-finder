# Git workflow

## Branches

- `main` is always deployable to staging. Protected: PR required, CI green, linear history (squash merge).
- Feature branches: `bf-0nn-short-slug` (e.g. `bf-033-site-schema`). Stacked parts: `bf-0nn-part-2-…`.

## Commits

Conventional Commits with ticket id: `feat(sites): add publication expiry job (BF-035)`. Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`, `build`, `ci`. Keep commits logically atomic; the squash commit message is the PR title.

## Pull requests

- Title `BF-0NN: <ticket title>`; body from `.github/pull_request_template.md`: plan, changes, decisions & assumptions, test evidence (`pnpm verify` summary), screenshots for UI, migration notes, follow-ups.
- Size: aim < 600 changed lines excluding generated code and fixtures. Split L tickets into stacked PRs.
- Migrations get their own PR when destructive (expand/contract).
- Close the issue via `Closes #<issue>` in the PR body.

## Parallel agents with worktrees

Independent tickets can be built simultaneously:

```bash
git worktree add ../bf-033 -b bf-033-site-schema origin/main
cd ../bf-033 && cp ../business-finder/.env .env
# give each worktree its own infra namespace and ports
echo "COMPOSE_PROJECT_NAME=bf_033" >> .env
echo "BF_PORT_OFFSET=10" >> .env       # multiples of 10 (10–70): web 3010, sites 3110, api 4010, pg 5442, … (BF-002)
pnpm install && pnpm infra:up
```

Each worktree runs its own compose project (separate Postgres/Valkey volumes) so agents never share state. Remove with `pnpm infra:down -v && git worktree remove ../bf-033`.

## Releases

- Staging deploys on every merge to `main`.
- Production releases are tags `vYYYY.MM.DD-N` created from `main`; release notes generated from PR titles.
