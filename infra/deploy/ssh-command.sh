#!/usr/bin/env bash
# Forced command of the CI deploy key (BF-025). Installed root-owned at /usr/local/bin/bf-deploy-command and named in
# /home/deploy/.ssh/authorized_keys as `restrict,command="/usr/local/bin/bf-deploy-command" ssh-ed25519 …`, so the key
# can do exactly these things and nothing else (no shell, no forwarding):
#   current           print the deployed tag                     previous   print the tag before it
#   upload <tag>      read a tar of docker-compose.prod.yml and deploy.sh on stdin: the compose file becomes
#                     releases/<tag>/ (rollbacks use each release's own file), deploy.sh the current script; a
#                     release version (vX.Y.Z, BF-061) also brings release.env, its images pinned by digest
#   login <user>      docker login ghcr.io with a token on stdin       logout   docker logout ghcr.io
#   deploy <tag>      run /opt/bf/deploy.sh <tag>
#   rollback          redeploy the previous tag (BF-061: a failed post-deploy smoke test)
# A tag is a full git sha (staging) or a release version vX.Y.Z (production).
set -euo pipefail

dir="${BF_DEPLOY_DIR:-/opt/bf}"
deny() {
  echo "refused: ${SSH_ORIGINAL_COMMAND:-<none>}" >&2
  exit 126
}

tag_re='^([0-9a-f]{40}|v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?)$'
read -r verb arg extra <<<"${SSH_ORIGINAL_COMMAND:-}" || true
[ -z "${extra:-}" ] || deny

case "${verb:-}" in
  current)
    [ -z "${arg:-}" ] || deny
    cat "$dir/IMAGE_TAG" 2>/dev/null || true
    ;;
  previous)
    [ -z "${arg:-}" ] || deny
    cat "$dir/IMAGE_TAG.previous" 2>/dev/null || true
    ;;
  upload)
    [[ "${arg:-}" =~ $tag_re ]] || deny
    members=(docker-compose.prod.yml seccomp-chromium.json deploy.sh)
    [[ "$arg" == v* ]] && members+=(release.env)
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    # At most 1 MB, only the expected members, as plain files (never links).
    head -c 1048576 | tar -x -C "$tmp" --no-same-owner --no-same-permissions "${members[@]}"
    for file in "${members[@]}"; do
      [ -f "$tmp/$file" ] && [ ! -L "$tmp/$file" ] || deny
    done
    install -d -m 0755 "$dir/releases/$arg"
    install -m 0644 "$tmp/docker-compose.prod.yml" "$dir/releases/$arg/docker-compose.prod.yml"
    install -m 0644 "$tmp/seccomp-chromium.json" "$dir/releases/$arg/seccomp-chromium.json"
    [ ! -f "$tmp/release.env" ] || install -m 0644 "$tmp/release.env" "$dir/releases/$arg/release.env"
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
    [[ "${arg:-}" =~ $tag_re ]] || deny
    exec "$dir/deploy.sh" "$arg"
    ;;
  rollback)
    [ -z "${arg:-}" ] || deny
    previous="$(cat "$dir/IMAGE_TAG.previous" 2>/dev/null || true)"
    [[ "$previous" =~ $tag_re ]] || { echo "no previous release to roll back to" >&2; exit 1; }
    BF_ROLLBACK=1 exec "$dir/deploy.sh" "$previous"
    ;;
  *)
    deny
    ;;
esac
