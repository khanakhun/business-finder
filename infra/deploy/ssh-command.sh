#!/usr/bin/env bash
# Forced command of the CI deploy key (BF-025). Installed root-owned at /usr/local/bin/bf-deploy-command and named in
# /home/deploy/.ssh/authorized_keys as `restrict,command="/usr/local/bin/bf-deploy-command" ssh-ed25519 …`, so the key
# can do exactly these things and nothing else (no shell, no forwarding):
#   current           print the deployed tag
#   upload <sha>      read a tar of docker-compose.prod.yml and deploy.sh on stdin: the compose file becomes
#                     releases/<sha>/ (rollbacks use each release's own file), deploy.sh the current script
#   login <user>      docker login ghcr.io with a token on stdin       logout   docker logout ghcr.io
#   deploy <sha>      run /opt/bf/deploy.sh <sha>
set -euo pipefail

dir="${BF_DEPLOY_DIR:-/opt/bf}"
deny() {
  echo "refused: ${SSH_ORIGINAL_COMMAND:-<none>}" >&2
  exit 126
}

read -r verb arg extra <<<"${SSH_ORIGINAL_COMMAND:-}" || true
[ -z "${extra:-}" ] || deny

case "${verb:-}" in
  current)
    [ -z "${arg:-}" ] || deny
    cat "$dir/IMAGE_TAG" 2>/dev/null || true
    ;;
  upload)
    [[ "${arg:-}" =~ ^[0-9a-f]{40}$ ]] || deny
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # At most 1 MB, only the expected members, as plain files (never links).
    head -c 1048576 | tar -x -C "$tmp" --no-same-owner --no-same-permissions \
      docker-compose.prod.yml seccomp-chromium.json deploy.sh
    for file in docker-compose.prod.yml seccomp-chromium.json deploy.sh; do
      [ -f "$tmp/$file" ] && [ ! -L "$tmp/$file" ] || deny
    done
    install -d -m 0755 "$dir/releases/$arg"
    install -m 0644 "$tmp/docker-compose.prod.yml" "$dir/releases/$arg/docker-compose.prod.yml"
    install -m 0644 "$tmp/seccomp-chromium.json" "$dir/releases/$arg/seccomp-chromium.json"
    install -m 0755 "$tmp/deploy.sh" "$dir/deploy.sh"
    ;;
  login)
    [[ "${arg:-}" =~ ^[A-Za-z0-9-]+(\[bot\])?$ ]] || deny
    docker login ghcr.io --username "$arg" --password-stdin
    ;;
  logout)
    [ -z "${arg:-}" ] || deny
    docker logout ghcr.io
    ;;
  deploy)
    [[ "${arg:-}" =~ ^[0-9a-f]{40}$ ]] || deny
    exec "$dir/deploy.sh" "$arg"
    ;;
  *)
    deny
    ;;
esac
