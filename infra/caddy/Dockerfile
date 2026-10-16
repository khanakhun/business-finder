# syntax=docker/dockerfile:1
# Caddy with a DNS provider module for DNS-01 challenges: the wildcard certificate for client sites
# (`*.{$SITES_BASE_DOMAIN}`) cannot be issued over HTTP-01 (BF-025, ADR-0014). Build from this directory:
#   docker build -t bf-caddy infra/caddy
#   docker build --build-arg DNS_MODULE=github.com/caddy-dns/route53@v1.6.0 -t bf-caddy infra/caddy
# The module must match the `dns` provider named in the Caddyfile (ACME_DNS_PROVIDER, default cloudflare).

ARG CADDY_BUILDER=caddy:2.11.7-builder@sha256:d842facfd63b960922e57444ff76fd8f0793a66dfdcf481af8026e1f4e6a39b4
ARG CADDY_IMAGE=caddy:2.11.7@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af

FROM ${CADDY_BUILDER} AS build
ARG DNS_MODULE=github.com/caddy-dns/cloudflare@v0.2.4
RUN xcaddy build --with "${DNS_MODULE}"

FROM ${CADDY_IMAGE}
COPY --from=build /usr/bin/caddy /usr/bin/caddy
COPY Caddyfile /etc/caddy/Caddyfile
# The official image runs as root to bind 80/443; capabilities instead, so Caddy itself never runs as root.
RUN setcap cap_net_bind_service=+ep /usr/bin/caddy \
    && addgroup -S -g 10002 caddy && adduser -S -D -H -u 10002 -G caddy caddy \
    && mkdir -p /data/caddy /config/caddy && chown -R caddy:caddy /data /config
USER caddy
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:2019/config/"]
