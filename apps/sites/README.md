# apps/sites — the site renderer (BF-036)

Serves every published site at `https://<slug>.<SITES_BASE_DOMAIN>/`, read-only, from the `renderer_published_sites`
view (BF-035) and the block library (`@bf/site-blocks`, BF-034). See `docs/ARCHITECTURE.md` §10 for the design.

## Run it locally

```sh
pnpm infra:up && pnpm db:migrate     # Postgres with the read-only role bf_sites_ro
pnpm sites:seed                      # publishes the four fixture sites as previews, prints their URLs
pnpm --filter @bf/sites dev          # http://salon-gustavia-demo01.sites.localhost:<SITES_PORT>/
```

`*.localhost` resolves to your machine in Chrome, Edge and Firefox, so each site is reachable by its own hostname
with no DNS setup (`SITES_BASE_DOMAIN=sites.localhost` is the local default; the port is `SITES_PORT`, 3100 plus your
`BF_PORT_OFFSET`). Tools that use the system resolver (curl, autocannon) may not resolve `*.localhost`: send the
request to `127.0.0.1` with the site's `Host` header (`curl -H 'Host: salon-gustavia-demo01.sites.localhost'
http://127.0.0.1:3100/`, with your `SITES_PORT`). The seed, e2e and Lighthouse runs publish under `sites.localhost`.

The block library's stylesheet and fonts are copied to `public/_bf` when the renderer starts: restart `dev` after
rebuilding `@bf/site-blocks`. In a container: `pnpm infra:up --profile sites` runs the renderer's image (built
from the repository, port `SITES_PORT`, so not alongside `dev` or the e2e suite), with the secrets from your `.env`
(local-only ones when unset).

Publishing from the dashboard works too: the API refreshes the renderer through `SITES_INTERNAL_URL` (set by
`infra:up`) when `SITES_REVALIDATE_SECRET` is the same on both sides; without it, a change shows within a minute.

## What it serves

| Request | Answer |
|---|---|
| A page of an active publication | the page (default language at `/`, others under `/<locale>/`), nonce CSP, `noindex` on previews |
| A path that is no page | 404 in the path's language, with the way home |
| `/<default-locale>/…` | 308 to the path without the prefix |
| An expired or unpublished preview | 410 naming the business and the agency |
| An unknown host | 404 |
| The database unreachable | the last known site for a few minutes, else 503 |
| `robots.txt` | previews: closed to all crawlers but our screenshot bot |
| `sitemap.xml` | live sites that ask to be indexed only |
| `POST /api/revalidate`, `/health/*` | the API's signed cache refresh and the health checks: on the internal address only (a site hostname gets its 404; Caddy refuses them too) |
| `/_bf/…` | the block library's stylesheet and fonts; anything else there is a plain 404 |

## Checks

```sh
pnpm --filter @bf/sites test         # unit (src/lib)
pnpm --filter @bf/sites e2e          # Playwright against a production build (seeds its own workspace)
pnpm --filter @bf/sites lighthouse   # Lighthouse CI on the seeded fixture previews (build first)
pnpm --filter @bf/sites load         # autocannon on a cached page (build and seed first)
```

The load check fails on any non-2xx response or when p97.5 (autocannon reports no p95; p97.5 bounds it from above)
passes 50 ms: with the default 10 connections it does today (the ticket's open load target, see its notes).

Previews show "This is my business" and "Not interested" in their banner (links to the renderer's `/claim` and
`/opt-out` pages, BF-048) once `SITES_PREVIEW_ACTIONS=true`.
