#!/bin/sh
# Role of an apps/api container (BF-025). `exec` so the Node process receives SIGTERM for graceful shutdown.
set -eu

role="${1:-http}"
[ "$#" -gt 0 ] && shift

run_ts() {
  exec node --import @swc-node/register/esm-register "$@"
}

case "$role" in
  http)
    run_ts --import ./src/instrumentation.ts src/main.ts "$@"
    ;;
  worker)
    run_ts --import ./src/instrumentation.ts src/worker.ts "$@"
    ;;
  migrate)
    # Forward-only migrations (packages/db/src/migrate.ts); safe to run on every deploy.
    cd /repo && exec node packages/db/src/cli/migrate.ts "$@"
    ;;
  *)
    # Any other package script of @bf/api (`admin:bootstrap --email …`), run from package.json without pnpm (the
    # runtime image has no package manager). A leading `--` (pnpm style) is accepted and dropped.
    script="$(node -e 'const s = require("./package.json").scripts[process.argv[1]]; if (s) console.log(s)' "$role")"
    if [ -z "$script" ]; then
      echo "unknown role or script: $role (http, worker, migrate, or a script of apps/api/package.json)" >&2
      exit 64
    fi
    [ "${1:-}" = "--" ] && shift
    # shellcheck disable=SC2016 # "$@" is expanded by the inner shell, after the script's own words
    exec sh -c "$script"' "$@"' "$role" "$@"
    ;;
esac
