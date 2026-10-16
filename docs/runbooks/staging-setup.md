# Runbook — staging server from scratch

Staging is one VPS running `infra/compose/docker-compose.prod.yml` behind Caddy ([ADR-0014](../adr/0014-hosting-vps-compose-caddy.md),
BF-025). Every green build of `main` deploys itself (`.github/workflows/deploy-staging.yml`); this runbook covers what
happens once, by hand: the server, DNS, secrets and the first deploy, plus rollback, logs and restores.

Commands prefixed `local$` run on your machine, `server$` on the VPS as the `deploy` user (unless `sudo`).

## 1. Server

- **Size**: 4 vCPU, 8 GB RAM, 160 GB SSD (grow RAM first: Postgres, Chromium in intel and Node processes share it).
- **Region**: US-East (New York / Virginia) — closest major region to the Caribbean (ADR-0014).
- **OS**: Ubuntu 24.04 LTS or Debian 13, fresh image, your SSH key added at creation.

Harden it (as root, once):

```sh
adduser --disabled-password --gecos "" deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown deploy:deploy /home/deploy/.ssh/authorized_keys

# SSH: keys only, no root login. A drop-in that sorts first wins over the image's own (cloud images ship
# /etc/ssh/sshd_config.d/50-cloud-init.conf with PasswordAuthentication yes).
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' \
  > /etc/ssh/sshd_config.d/00-hardening.conf
sshd -t && systemctl restart ssh
sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin)'   # expect "no" for both

# Firewall: SSH, HTTP, HTTPS (and HTTP/3) only.
apt-get update && apt-get install -y ufw fail2ban unattended-upgrades curl ca-certificates
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades
```

The intel container renders crawled pages in Chromium **with Chromium's own sandbox**, which needs unprivileged user
namespaces (its seccomp profile, `seccomp-chromium.json`, allows them; it ships with each release). Ubuntu 24.04
restricts them through AppArmor by default; allow them (Debian 13 needs nothing):

```sh
[ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && \
  echo 'kernel.apparmor_restrict_unprivileged_userns = 0' > /etc/sysctl.d/60-bf-chromium-sandbox.conf && \
  sysctl --system
```

If the sandbox cannot start, intel's readiness check (`browser`) fails, its container stays unhealthy and the deploy
rolls back — `dc logs intel` says why. `SITE_INTEL_CHROMIUM_SANDBOX=false` in `intel.env` is a stop-gap only.

Install Docker Engine and the Compose plugin **from Docker's repository** (follow
<https://docs.docker.com/engine/install/> for your distribution), then:

```sh
usermod -aG docker deploy
install -d -m 750 -o deploy -g deploy /opt/bf
```

> Docker publishes ports through its own iptables rules, ahead of ufw. Only Caddy publishes ports in the compose file,
> so nothing else is reachable; keep it that way (never add `ports:` to another service).

## 2. DNS

With `example.com` standing for your staging domain (`BASE_DOMAIN`) and `example-sites.com` for the client-sites
domain (`SITES_BASE_DOMAIN`):

| Record | Type | Value |
|---|---|---|
| `app.example.com` | A | server IP |
| `api.example.com` | A | server IP |
| `*.example-sites.com` | A | server IP |
| `example.com`, `example-sites.com` | CAA | `0 issue "letsencrypt.org"` |

- **A records only (IPv4)**: the compose networks have no IPv6, so IPv6 visitors would all reach the apps as one
  address (one rate-limit bucket for everyone). Add AAAA records only after enabling IPv6 on the `edge` network.
- **DNS only, not proxied** (Cloudflare: grey cloud): with the proxy on, every visitor becomes a Cloudflare address.
- **Client sites on a separate registrable domain**, never a subdomain of `BASE_DOMAIN`: the session cookie is shared
  across `AUTH_COOKIE_DOMAIN`, and generated sites must not be same-site with the dashboard (the github.io pattern).

The wildcard certificate needs a DNS-01 challenge: create an API token for the DNS provider limited to **editing DNS of
the sites zone only** (Cloudflare: *Zone → DNS → Edit*, one zone). The Caddy image includes the Cloudflare module by
default; for another provider, build `infra/caddy` with `--build-arg DNS_MODULE=github.com/caddy-dns/<provider>@<version>`
and set `ACME_DNS_PROVIDER` (see `infra/caddy/Dockerfile`).

## 3. Secrets: one file per audience in `/opt/bf`

Each container receives only what it needs (`infra/compose/docker-compose.prod.yml`): the public `web` gets no
secret at all, `intel` (which renders untrusted pages) only its shared secret. Create the files empty and private:

```sh
server$ cd /opt/bf && for f in .env app.env caddy.env backup.env intel.env; do install -m 600 /dev/null "$f"; done
```

Generate every secret on the server, never reuse local ones, and keep a copy in the team password manager. Use
`openssl rand -hex 32` for passwords that end up in a connection URL (the Postgres ones: base64's `/`, `+` and `=`
would break the URL) and `openssl rand -base64 32` for the others.

**`.env`** — compose variables (interpolated into the compose file, never handed to a container whole):

| Variable | Value |
|---|---|
| `IMAGE_REGISTRY` | `ghcr.io/<github-owner>` (lowercase) |
| `POSTGRES_IMAGE_TAG`, `CADDY_IMAGE_TAG`, `BACKUP_IMAGE_TAG` | the sha of a `main` build whose images to use; bump on purpose (a new Postgres tag restarts the database) |
| `BASE_DOMAIN`, `SITES_BASE_DOMAIN` | the domains of §2 |
| `ACME_EMAIL` | an address that receives certificate warnings |
| `ACME_DNS_PROVIDER` | `cloudflare` (default) or the module you built |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | e.g. `bf`, `openssl rand -hex 32`, `bf` |
| `BF_SITES_RO_PASSWORD` | `openssl rand -hex 32` (read-only role of apps/sites) |
| `INTEL_SHARED_SECRET` | generated (also in `app.env`, same value) |
| `SITES_REVALIDATE_SECRET`, `SITES_VIEW_TOKEN_SECRET` | `openssl rand -hex 32` each: shared by the API, the worker and the site renderer (compose passes them; not in `app.env`) |
| `SITES_ASSETS_BASE_URL` | the public URL of site images (the CDN or public bucket in front of `S3_BUCKET_SITES`) |
| `PG_SHARED_BUFFERS`, `PG_EFFECTIVE_CACHE_SIZE`, `PG_WORK_MEM`, … | optional tuning (defaults fit 8 GB) |

**`app.env`** — the api and worker. Start from the repository's `.env.example` (every variable, described in
[ENVIRONMENT.md](../ENVIRONMENT.md)) and set at least:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgres://<POSTGRES_USER>:<POSTGRES_PASSWORD>@postgres:5432/<POSTGRES_DB>` (separate migration and runtime roles come with BF-060) |
| `VALKEY_URL` | `redis://valkey:6379/0` |
| `BETTER_AUTH_SECRET` | generated, ≥ 32 characters |
| `SECRETS_MASTER_KEY` | `openssl rand -base64 32` — **back it up**: workspace secrets are unreadable without it |
| `AUTH_COOKIE_DOMAIN` | `example.com` (the session cookie is shared by `app.` and `api.`) |
| `INTEL_SHARED_SECRET` | the value of `.env` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_ASSETS`, `S3_BUCKET_ARTIFACTS`, `S3_BUCKET_SITES` | object storage (create the buckets first) |
| `SMTP_URL`, `MAIL_FROM` | system mail (invitations, password resets) |
| AI and provider keys | as needed (`ANTHROPIC_API_KEY`, `GOOGLE_PLACES_API_KEY`, …) |

The compose file sets the URLs between services (`APP_URL`, `API_URL`, `INTEL_URL`, `API_INTERNAL_URL`, `SITES_INTERNAL_URL`,
`NEXT_PUBLIC_*`, `AUTH_TRUSTED_PROXIES`) from `BASE_DOMAIN`; do not set them in `app.env`.

**`caddy.env`** — `ACME_DNS_API_TOKEN` (the zone-scoped token of §2), nothing else.

**`backup.env`** — the backup job:

| Variable | Value |
|---|---|
| `BACKUP_ENCRYPTION_PASSPHRASE` | generated; dumps are encrypted with it before upload — **store it off the server**: no restore without it |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET` | a **separate** bucket, versioning (or object lock) on |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | a key limited to that bucket (list, read, write, delete — retention deletes old dumps). With versioning, add a lifecycle rule that expires noncurrent versions after a few days, or deleted dumps linger |
| `BACKUP_S3_PREFIX`, `BACKUP_AT`, `BACKUP_RETENTION_DAYS` | optional: `staging/postgres`, `03:00` (UTC), `14` |

**`intel.env`** — services/intel renders untrusted pages, so it gets a key of its own: `S3_ENDPOINT`, `S3_REGION`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` limited to `S3_BUCKET_ARTIFACTS` (its open-data cache, used only with
`OPEN_DATA_OBJECT_CACHE=true`), plus optional tuning (`OPEN_DATA_*`, `OVERTURE_*`).

## 4. Deploy key and GitHub configuration

The CI key may only run `infra/deploy/ssh-command.sh` (print the deployed tag, upload the compose file and deploy
script, log in/out of GHCR, `deploy <sha>`): no shell, no forwarding.

1. Install the forced command, root-owned (from a checkout of `main`):
   `server$ sudo install -o root -g root -m 0755 ssh-command.sh /usr/local/bin/bf-deploy-command`
   **Reinstall it whenever `infra/deploy/ssh-command.sh` changes**, from the new `main`, then re-run
   **deploy-staging**. (BF-026 added `seccomp-chromium.json` to the upload: the first deploy after that merge stops
   early, with a message saying so, until the command is reinstalled — nothing is changed on the server.)
2. Create the key pair: `local$ ssh-keygen -t ed25519 -f bf-staging-deploy -C bf-staging-deploy`, then add **one line**
   to `/home/deploy/.ssh/authorized_keys`:
   `restrict,command="/usr/local/bin/bf-deploy-command" ssh-ed25519 AAAA… bf-staging-deploy`
   (your personal key stays a normal line above it).
3. Pin the host key: `local$ ssh-keyscan -t ed25519 <server-ip>` and **compare the fingerprint** with the one the server
   shows (`server$ ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).
4. Repository → Settings → Environments → `staging`:
   - **Deployment branches and tags: `main` only** (and required reviewers if you want a human gate);
   - secrets `STAGING_HOST` (IP or name), `STAGING_USER` (`deploy`), `STAGING_SSH_KEY` (the private key),
     `STAGING_KNOWN_HOSTS` (the verified `ssh-keyscan` line);
   - variable `STAGING_BASE_DOMAIN` (`example.com`).
5. CI publishes `ghcr.io/<owner>/bf-{api,web,intel,postgres,caddy,backup}:<sha>` on `main`. The deploy job logs the
   server in to GHCR with its own short-lived token (and out again), so packages may stay private.

## 5. First deploy

Merge to `main` (or run **Actions → deploy-staging → Run workflow** with a sha of a green `main` build). The job checks
that the sha is on `main`, uploads `docker-compose.prod.yml` and `seccomp-chromium.json` (the intel container's
seccomp profile: Docker's default plus the user namespaces Chromium's sandbox needs) to `/opt/bf/releases/<sha>/` (a
rollback uses each release's own files), and `deploy.sh` **from main**, then runs
`deploy.sh <sha>` (a build older than the deployed one is skipped):

1. `docker compose pull`
2. `docker compose run --rm migrate` (forward-only migrations; a failure stops here, nothing changed)
3. `docker compose up -d --remove-orphans --wait`
4. health gate: `https://api.<domain>/health/ready` and `https://app.<domain>/health/ready` through Caddy
5. success → the sha goes to `/opt/bf/IMAGE_TAG` (the previous one to `IMAGE_TAG.previous`); failure → the previous tag
   is started again and the job fails (the job log shows container states only; logs stay on the server, §6)

Then create the first owner (prints a one-time link to choose a password):

```sh
server$ cd /opt/bf && IMAGE_TAG=$(cat IMAGE_TAG) RELEASE_DIR="/opt/bf/releases/$(cat IMAGE_TAG)" \
          docker compose -p bf --project-directory . --env-file .env \
          -f "releases/$(cat IMAGE_TAG)/docker-compose.prod.yml" \
          run --rm api admin:bootstrap --email you@example.com --name "Your Name" --workspace "Your agency"
```

Check from anywhere: `local$ node scripts/smoke-staging.mjs https://app.example.com https://api.example.com`.

## 6. Day to day

Run these in `/opt/bf` after:

```sh
export IMAGE_TAG=$(cat IMAGE_TAG) RELEASE_DIR="/opt/bf/releases/$(cat IMAGE_TAG)"
alias dc='docker compose -p bf --project-directory /opt/bf --env-file /opt/bf/.env -f "/opt/bf/releases/$IMAGE_TAG/docker-compose.prod.yml"'
```

| Task | Command |
|---|---|
| Status | `dc ps` |
| Logs (JSON, rotated at 10 MB × 5) | `dc logs -f --tail 200 api worker` · `dc logs caddy` (access logs) |
| Restart one service | `dc restart worker` |
| Roll back by hand | re-run **deploy-staging** with the previous sha (`cat IMAGE_TAG.previous`); on the server: `docker login ghcr.io` with a read-only token if the packages are private, then `./deploy.sh $(cat IMAGE_TAG.previous)` |
| Shell in the database | `dc exec postgres psql -U bf bf` |
| Deploy by hand | `./deploy.sh <sha>` (images must exist in GHCR; `docker login ghcr.io` first if private). A lock stops it from overlapping a CI deploy |
| Optional services | `dc --profile scraper up -d gmaps-scraper` · `dc --profile verify up -d reacher` (needs outbound port 25; put a generated `RCH__HEADER_SECRET` in `reacher.env`, and `REACHER_URL=http://reacher:8080` plus the same secret as `REACHER_HEADER_SECRET` in `app.env`; then Settings → Integrations → "Check port 25") |

Rollbacks never undo migrations: they are forward-only and keep the previous release working (expand/contract).

## 7. Backups and restore

The `backup` service dumps the database every night at `BACKUP_AT` (UTC) with `pg_dump --format=custom`, encrypts it
(rclone crypt, `BACKUP_ENCRYPTION_PASSPHRASE`), uploads it to `BACKUP_S3_BUCKET/BACKUP_S3_PREFIX` and deletes dumps
older than `BACKUP_RETENTION_DAYS`. Point-in-time recovery is BF-061 (production).

| Task | Command |
|---|---|
| Back up now | `dc run --rm backup backup` |
| List dumps | `dc run --rm backup list` |
| Check a dump (restore into a scratch database) | `dc exec postgres createdb -U bf bf_restore_check` then `dc run --rm backup restore <name> --into bf_restore_check` |
| Restore staging itself | stop writers (`dc stop api worker web`), `dc run --rm backup restore <name> --overwrite-live`, then `./deploy.sh $(cat IMAGE_TAG)` |

`restore` runs `pg_restore --clean --if-exists` and refuses to run without `--into` or `--overwrite-live`. Restores
were tested end to end in BF-025 (dump → encrypted object → new database, identical schema).

## 8. When something is wrong

- **Deploy failed, rolled back**: the job log shows each container's state and exit code only (it is public);
  `dc logs <service>` on the server has the details. Fix forward with a new commit.
- **Access logs** (`dc logs caddy`) contain visitors' addresses and full request URLs (one-time links included): read
  them on the server, never paste them into issues or chats. Docker rotates them (10 MB × 5 per container).
- **Rollback failed too**: `dc ps` and `dc logs`; usually configuration (`.env`) or a full disk (`df -h`,
  `docker system df`; `docker image prune -a --filter until=168h`).
- **Certificates**: `dc logs caddy | grep -i acme`. DNS-01 errors are almost always the token's scope or the zone.
- **Realtime (SSE) stuck**: Caddy streams `/v1/realtime` unbuffered (`flush_interval -1`, no compression); check
  `curl -N https://api.example.com/v1/realtime` with a session cookie prints `: ready` at once.
