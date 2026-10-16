#!/usr/bin/env bash
# Deploys one image tag on the server (BF-025): pull → migrate → start → health gate through Caddy → keep, or roll
# back to the previous tag and fail. Run from the deploy directory (default /opt/bf) as the deploy user:
#   ./deploy.sh <image-tag>
# Expects .env (mode 600) next to it, with IMAGE_REGISTRY and the infrastructure image tags. Each release brings its
# own compose file in releases/<tag>/ (uploaded by CI); a rollback starts the previous tag with *its* file. Without a
# release directory (local rehearsal, manual run), ./docker-compose.prod.yml is used.
# Migrations are forward-only (expand/contract), so the previous images keep working on the migrated schema.
set -euo pipefail

new_tag="${1:?usage: deploy.sh <image-tag>}"
# Image tags are full git shas (CI); a local rehearsal with its own images (BF_SKIP_PULL=1) may use any word.
if [ "${BF_SKIP_PULL:-}" != 1 ] && ! [[ "$new_tag" =~ ^[0-9a-f]{40}$ ]]; then
  echo "image tag must be a full git sha" >&2
  exit 64
fi
deploy_dir="${BF_DEPLOY_DIR:-/opt/bf}"
health_timeout="${BF_HEALTH_TIMEOUT:-180}"
project="${BF_COMPOSE_PROJECT:-bf}"
cd "$deploy_dir"

# One deploy at a time (CI and a hand-run deploy must not interleave), and a dropped SSH session must not kill it
# halfway through `up`: hangups are ignored, the run finishes (or rolls back) on its own.
exec 9>"$deploy_dir/.deploy.lock"
flock -n 9 || { echo "another deploy is running" >&2; exit 75; }
trap '' HUP

[ -f .env ] || { echo "missing $deploy_dir/.env" >&2; exit 1; }
# The few settings this script needs, read as data (a Docker env file is not shell syntax: never source it).
env_value() { sed -n "s/^$1=//p" .env | tail -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
BASE_DOMAIN="${BASE_DOMAIN:-$(env_value BASE_DOMAIN)}"
CADDY_TLS="${CADDY_TLS:-$(env_value CADDY_TLS)}"
HTTPS_PORT="${HTTPS_PORT:-$(env_value HTTPS_PORT)}"
export IMAGE_REGISTRY="${IMAGE_REGISTRY:-$(env_value IMAGE_REGISTRY)}"
: "${BASE_DOMAIN:?BASE_DOMAIN must be set in .env}"
: "${IMAGE_REGISTRY:?IMAGE_REGISTRY must be set in .env}"

current_tag="$(cat IMAGE_TAG 2>/dev/null || true)"

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
compose_file() {
  if [ -f "releases/$1/docker-compose.prod.yml" ]; then echo "releases/$1/docker-compose.prod.yml"
  else echo docker-compose.prod.yml; fi
}
# The deploy directory stays the project directory wherever the release's file lives: .env and the env files
# (app.env, caddy.env, backup.env) are read from there.
compose() {
  IMAGE_TAG="$1" docker compose --project-name "$project" --project-directory "$deploy_dir" \
    --env-file "$deploy_dir/.env" --file "$(compose_file "$1")" "${@:2}"
}

# Through Caddy, as a visitor would arrive (TLS and routing included), but resolved locally.
healthy() {
  local deadline=$((SECONDS + health_timeout))
  local insecure=()
  [ "${CADDY_TLS:-acme}" = internal ] && insecure=(--insecure)
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS "${insecure[@]}" --max-time 5 --resolve "api.${BASE_DOMAIN}:${HTTPS_PORT:-443}:127.0.0.1" \
         "https://api.${BASE_DOMAIN}:${HTTPS_PORT:-443}/health/ready" >/dev/null 2>&1 &&
       curl -fsS "${insecure[@]}" --max-time 5 --resolve "app.${BASE_DOMAIN}:${HTTPS_PORT:-443}:127.0.0.1" \
         "https://app.${BASE_DOMAIN}:${HTTPS_PORT:-443}/health/ready" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

log "deploying ${new_tag} (current: ${current_tag:-none})"
# BF_SKIP_PULL=1: images built on this machine (local rehearsal of a deploy, docs/runbooks/staging-setup.md).
[ "${BF_SKIP_PULL:-}" = 1 ] || compose "$new_tag" pull --quiet
log "running migrations"
compose "$new_tag" run --rm migrate
log "starting containers"
if compose "$new_tag" up --detach --remove-orphans --wait --wait-timeout "$health_timeout" && healthy; then
  # Redeploying the same tag keeps the real previous one (a manual rollback must not become a no-op).
  if [ -n "$current_tag" ] && [ "$current_tag" != "$new_tag" ]; then echo "$current_tag" > IMAGE_TAG.previous; fi
  echo "$new_tag" > IMAGE_TAG
  # Keep the current and previous releases (files and images); everything older goes.
  previous_tag="$(cat IMAGE_TAG.previous 2>/dev/null || true)"
  if [ -d releases ]; then
    for release in releases/*/; do
      tag="$(basename "$release")"
      [ "$tag" = "$new_tag" ] || [ "$tag" = "$previous_tag" ] || rm -rf "$release"
    done
  fi
  docker image ls --format '{{.Repository}}:{{.Tag}}' "${IMAGE_REGISTRY}/bf-*" \
    | grep -Ev ":(${new_tag}|${previous_tag:-none})$" | grep -E ':[0-9a-f]{40}$' \
    | xargs -r docker image rm >/dev/null 2>&1 || true
  log "deployed ${new_tag}"
  exit 0
fi

log "health check failed for ${new_tag}"
# State only: this output reaches a public CI log, so container logs (visitor IPs, tokens in URLs) stay on the
# server — `docker compose logs <service>` there (runbook §8).
compose "$new_tag" ps --all --format '{{.Service}}: {{.State}} {{.Health}} (exit {{.ExitCode}})' || true
if [ -n "$current_tag" ] && [ "$current_tag" != "$new_tag" ]; then
  log "rolling back to ${current_tag}"
  if compose "$current_tag" up --detach --remove-orphans --wait --wait-timeout "$health_timeout" && healthy; then
    log "rolled back to ${current_tag}"
  else
    log "ROLLBACK FAILED: ${current_tag} is not healthy either — see docs/runbooks/staging-setup.md"
  fi
fi
exit 1
