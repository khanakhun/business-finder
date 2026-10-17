#!/usr/bin/env bash
# Rolls production (or staging) back to the previous release (BF-061, docs/runbooks/rollback.md). On the server, in
# the deploy directory, as the deploy user:
#   ./rollback.sh            redeploy IMAGE_TAG.previous (its own compose file and pinned images)
#   ./rollback.sh <tag>      redeploy a release still in releases/ (a sha or vX.Y.Z)
# Migrations are forward-only (expand/contract), so an older release runs on the current schema. The release that was
# rolled back from is not recorded as the next rollback target. From CI the same is `ssh <host> rollback`.
set -euo pipefail
dir="${BF_DEPLOY_DIR:-/opt/bf}"
target="${1:-$(cat "$dir/IMAGE_TAG.previous" 2>/dev/null || true)}"
[ -n "$target" ] || { echo "no previous release recorded in $dir/IMAGE_TAG.previous" >&2; exit 1; }
[ -d "$dir/releases/$target" ] || [ -f "$dir/docker-compose.prod.yml" ] \
  || { echo "release $target is no longer on this server: deploy it again from CI" >&2; exit 1; }
echo "rolling back from $(cat "$dir/IMAGE_TAG" 2>/dev/null || echo none) to $target"
BF_ROLLBACK=1 exec "$dir/deploy.sh" "$target"
