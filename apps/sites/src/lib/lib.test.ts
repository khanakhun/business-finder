import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { signInternalRequest } from '@bf/contracts';
import { type SiteSpec, SiteSpecSchema } from '@bf/site-schema';
import { describe, expect, it } from 'vitest';
import { preferredLocale } from './accept-language.ts';
import { cacheUntil, STALE_GRACE_MS, TENANT_TTL_MS, UNKNOWN_TTL_MS } from './cache-policy.ts';
import { readCappedText } from './capped-body.ts';
import { buildSiteCsp } from './csp.ts';
import { siteHostname, underSitesDomain } from './host.ts';
import { pageAlternates, resolveRoute } from './locale-routing.ts';
import { NonceCache } from './nonce-cache.ts';
import { REVALIDATE_PATH, revalidate, revalidateNonces } from './revalidate.ts';
import { PREVIEW_BOT, robotsTxt, sitemapXml, siteOrigin, siteScheme } from './seo.ts';
import { statusPage } from './status-page.ts';
import { RENDERER_STRINGS, rendererStrings } from './strings.ts';
import { TagCache } from './tag-cache.ts';

const fixtures = join(
  dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json')),
  'fixtures',
);
const fixture = (name: string): SiteSpec =>
  SiteSpecSchema.parse(JSON.parse(readFileSync(join(fixtures, `${name}.json`), 'utf8')));

describe('underSitesDomain', () => {
  it.each([
    'sites.example',
    'a.sites.example',
    'A_B.Sites.Example:443',
    '-x.sites.example.',
    'a.b.sites.example',
  ])('counts %s as under the sites domain (no internal route there)', (host) => {
    expect(underSitesDomain(host, 'sites.example')).toBe(true);
  });

  it.each([null, '', 'sites:3000', '127.0.0.1:3100', 'localhost:3100', 'evilsites.example'])(
    'counts %s as the internal address',
    (host) => {
      expect(underSitesDomain(host, 'sites.example')).toBe(false);
    },
  );
});

describe('siteHostname', () => {
  it.each([
    ['salon-k3x9p2.sites.example', 'salon-k3x9p2.sites.example'],
    ['Salon-K3X9P2.Sites.Example:3110', 'salon-k3x9p2.sites.example'],
    ['salon-k3x9p2.sites.example.', 'salon-k3x9p2.sites.example'],
  ])('reads %s as %s', (host, hostname) => {
    expect(siteHostname(host, 'sites.example')).toBe(hostname);
  });

  it.each([
    null,
    '',
    'sites.example',
    'a.b.sites.example',
    'salon.other.example',
    'evilsites.example',
    '-salon.sites.example',
    'sal_on.sites.example',
    '127.0.0.1:3100',
    '[::1]:3100',
  ])('refuses %s', (host) => {
    expect(siteHostname(host, 'sites.example')).toBeUndefined();
  });
});

describe('resolveRoute', () => {
  const salon = fixture('salon-gustavia');
  const other = salon.locales.find((locale) => locale !== salon.defaultLocale) ?? 'en';
  const services = salon.pages.find((page) => page.slug !== '');

  it('serves the default language at the root and the others under their prefix', () => {
    expect(resolveRoute(salon, [])).toMatchObject({ page: { slug: '' }, locale: salon.defaultLocale });
    expect(resolveRoute(salon, [services?.slug ?? ''])).toMatchObject({ page: { id: services?.id } });
    expect(resolveRoute(salon, [other])).toMatchObject({ page: { slug: '' }, locale: other });
    expect(resolveRoute(salon, [other, services?.slug ?? ''])).toMatchObject({
      locale: other,
      page: { id: services?.id },
    });
  });

  it('has no page for an unknown slug, a nested path or the default language prefix', () => {
    expect(resolveRoute(salon, ['nope'])).toBeUndefined();
    expect(resolveRoute(salon, [services?.slug ?? '', 'deeper'])).toBeUndefined();
    expect(resolveRoute(salon, [salon.defaultLocale, services?.slug ?? ''])).toBeUndefined();
    expect(resolveRoute(salon, ['de'])).toBeUndefined();
  });

  it('keeps the same page across languages', () => {
    if (!services) throw new Error('no services page');
    const alternates = pageAlternates(salon, services);
    expect(alternates[salon.defaultLocale]).toBe(`/${services?.slug}`);
    expect(alternates[other]).toBe(`/${other}/${services?.slug}`);
  });
});

describe('buildSiteCsp', () => {
  const base = {
    dev: false,
    https: true,
    apiOrigin: 'https://api.example',
    assetsOrigin: 'https://assets.example',
    frameOrigins: [],
  };

  it('allows scripts by nonce only, images from our CDN, the API for the beacon, and no frame by default', () => {
    const csp = buildSiteCsp('abc', base);
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("img-src 'self' data: https://assets.example");
    expect(csp).toContain("connect-src 'self' https://api.example");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    // Style elements by nonce; only style attributes inline.
    expect(csp).toContain("style-src-elem 'self' 'nonce-abc'");
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).not.toMatch(/style-src(-elem)? [^;]*'unsafe-inline'/);
  });

  it('frames only the site’s booking provider; development allows eval and the dev socket', () => {
    const csp = buildSiteCsp('abc', {
      ...base,
      dev: true,
      https: false,
      frameOrigins: ['https://calendly.com'],
    });
    expect(csp).toContain('frame-src https://calendly.com');
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain(' ws:');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});

describe('TagCache', () => {
  it('serves an entry until its expiry or one of its tags is invalidated', () => {
    const cache = new TagCache<string>();
    cache.set('a.sites', 'A', 1_000, ['host:a.sites', 'site:1']);
    cache.set('b.sites', 'B', 1_000, ['host:b.sites', 'site:2']);
    expect(cache.get('a.sites', 500)).toBe('A');
    expect(cache.get('a.sites', 1_000)).toBeUndefined();
    cache.set('a.sites', 'A', 2_000, ['host:a.sites', 'site:1']);
    expect(cache.invalidate(['site:1', 'site:9'])).toBe(1);
    expect(cache.get('a.sites', 500)).toBeUndefined();
    expect(cache.get('b.sites', 500)).toBe('B');
  });

  it('keeps at most its size, dropping the least recently used first', () => {
    const cache = new TagCache<number>(2);
    for (const n of [1, 2]) cache.set(`k${n}`, n, 10, []);
    expect(cache.get('k1', 0)).toBe(1);
    cache.set('k3', 3, 10, []);
    expect(cache.size).toBe(2);
    expect(cache.get('k2', 0)).toBeUndefined();
    expect(cache.get('k1', 0)).toBe(1);
    expect(cache.get('k3', 0)).toBe(3);
  });
});

describe('NonceCache', () => {
  it('refuses a nonce while it is remembered, and forgets it after', () => {
    const nonces = new NonceCache(100);
    expect(nonces.use('n1', 0)).toBe(true);
    expect(nonces.use('n1', 50)).toBe(false);
    expect(nonces.use('n1', 150)).toBe(true);
  });

  it('stays bounded', () => {
    const nonces = new NonceCache(1_000, 3);
    for (const n of [1, 2, 3, 4, 5]) nonces.use(`n${n}`, 0);
    // The oldest were dropped to keep the bound.
    expect(nonces.use('n1', 1)).toBe(true);
  });
});

describe('revalidate', () => {
  const secret = 'renderer-revalidate-secret-for-tests-0123456789';
  const body = JSON.stringify({
    tags: ['site:0199e0a0-0000-7000-8000-000000000001', 'host:salon.sites.example'],
  });
  const now = 1_790_000_000_000;

  const call = async (overrides: { body?: string; authorization?: string | null; secret?: string } = {}) => {
    const invalidated: string[][] = [];
    const deps = {
      secret: overrides.secret ?? secret,
      nonces: revalidateNonces(),
      invalidate: (tags: readonly string[]) => invalidated.push([...tags]),
      now,
    };
    const requestBody = overrides.body ?? body;
    const authorization =
      overrides.authorization === undefined
        ? await signInternalRequest(
            { method: 'POST', path: REVALIDATE_PATH, body: requestBody },
            { secret, timestamp: Math.floor(now / 1000) },
          )
        : overrides.authorization;
    return {
      result: await revalidate({ authorization, path: REVALIDATE_PATH, body: requestBody }, deps),
      invalidated,
      deps,
    };
  };

  it('drops the named tags for a signed request, once', async () => {
    const { result, invalidated, deps } = await call();
    expect(result).toMatchObject({ status: 200, body: { revalidated: 1 } });
    expect(invalidated).toEqual([['site:0199e0a0-0000-7000-8000-000000000001', 'host:salon.sites.example']]);
    const authorization = await signInternalRequest(
      { method: 'POST', path: REVALIDATE_PATH, body },
      { secret, timestamp: Math.floor(now / 1000), nonce: 'fixed-nonce-0123456789' },
    );
    const request = { authorization, path: REVALIDATE_PATH, body };
    expect((await revalidate(request, deps)).status).toBe(200);
    expect(await revalidate(request, deps)).toMatchObject({ status: 409, body: { error: 'replayed' } });
  });

  it('refuses an unsigned, tampered or foreign request, bad tags, and answers 503 without a secret', async () => {
    expect((await call({ authorization: null })).result).toMatchObject({
      status: 401,
      body: { error: 'missing' },
    });
    expect((await call({ authorization: 'Bearer 1.abcdefghijklmnop.00' })).result.status).toBe(401);
    const signed = await signInternalRequest(
      { method: 'POST', path: REVALIDATE_PATH, body },
      { secret: 'another-secret-entirely-0123456789abcdef', timestamp: Math.floor(now / 1000) },
    );
    expect((await call({ authorization: signed })).result).toMatchObject({
      status: 401,
      body: { error: 'bad_signature' },
    });
    expect((await call({ body: JSON.stringify({ tags: ['everything'] }) })).result.status).toBe(400);
    expect((await call({ body: 'not json' })).result.status).toBe(400);
    expect((await call({ secret: '' })).result.status).toBe(503);
  });
});

describe('preferredLocale', () => {
  it.each([
    ['fr-FR,fr;q=0.9,en;q=0.8', 'fr'],
    ['en-US,en;q=0.9', 'en'],
    ['ja,de;q=0.5', 'de'],
    ['es;q=0.2,nl;q=0.8', 'nl'],
    ['fr;q=0', 'en'],
    [null, 'en'],
  ])('reads %s as %s', (header, locale) => {
    expect(preferredLocale(header)).toBe(locale);
  });
});

describe('robots, sitemap and origin', () => {
  it('closes a preview to every crawler but our screenshot bot, and opens a live site with its sitemap', () => {
    expect(robotsTxt({ indexable: false, origin: 'https://a.sites.example' })).toBe(
      `User-agent: ${PREVIEW_BOT}\nAllow: /\n\nUser-agent: *\nDisallow: /\n`,
    );
    expect(robotsTxt({ indexable: true, origin: 'https://a.example' })).toContain(
      'Sitemap: https://a.example/sitemap.xml',
    );
  });

  it('lists every page in every language with its alternates', () => {
    const salon = fixture('salon-gustavia');
    const xml = sitemapXml(salon, 'https://a.example');
    expect(xml.match(/<url>/g)).toHaveLength(salon.pages.length * salon.locales.length);
    expect(xml).toContain('<loc>https://a.example/</loc>');
    expect(xml).toContain('hreflang="en"');
  });

  it('builds a site’s origin from its normalised hostname, never the raw Host header', () => {
    expect(siteScheme(new Headers({ 'x-forwarded-proto': 'http' }), 'production')).toBe('https');
    expect(siteScheme(new Headers({ 'x-forwarded-proto': 'https, http' }), 'development')).toBe('https');
    expect(siteScheme(new Headers(), 'development')).toBe('http');
    expect(
      siteOrigin({
        hostname: 'a.sites.example',
        scheme: 'https',
        host: 'A.SITES.EXAMPLE.:9999',
        production: true,
      }),
    ).toBe('https://a.sites.example');
    expect(
      siteOrigin({
        hostname: 'a.sites.localhost',
        scheme: 'http',
        host: 'a.sites.localhost:3110',
        production: false,
      }),
    ).toBe('http://a.sites.localhost:3110');
  });
});

describe('status pages and strings', () => {
  it('escapes every text and link', () => {
    const html = statusPage({
      lang: 'fr',
      title: '<script>alert(1)</script>',
      body: 'Salon "Lumière" & co',
      link: { href: 'https://agency.example/?a=1&b="2"', label: '<b>Agence</b>' },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="https://agency.example/?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain('&lt;b&gt;Agence&lt;/b&gt;');
  });

  it('has every string in every site language, and English for an unknown one', () => {
    for (const strings of Object.values(RENDERER_STRINGS)) {
      expect(strings.goneBody('Salon', 'Agence')).toContain('Salon');
      expect(strings.contactAgency('Agence')).toContain('Agence');
    }
    expect(rendererStrings('xx')).toBe(RENDERER_STRINGS.en);
    expect(rendererStrings(undefined)).toBe(RENDERER_STRINGS.en);
  });
});

describe('readCappedText', () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://x/api/revalidate', { method: 'POST', body, headers });

  it('reads a small body and refuses a large one, declared or not', async () => {
    expect(await readCappedText(post('{"tags":[]}'), 100)).toBe('{"tags":[]}');
    expect(await readCappedText(post('x'.repeat(101)), 100)).toBeUndefined();
    expect(await readCappedText(post('x', { 'content-length': '9999' }), 100)).toBeUndefined();
    const streamed = new Request('http://x/', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 10; i += 1) controller.enqueue(new Uint8Array(50));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(await readCappedText(streamed, 100)).toBeUndefined();
  });
});

describe('cacheUntil', () => {
  const now = Date.parse('2026-10-16T12:00:00.000Z');

  it('keeps a lookup a minute, an unknown host ten seconds, and never past a preview’s expiry', () => {
    expect(cacheUntil({ status: 'active', expiresAt: null }, now)).toBe(now + TENANT_TTL_MS);
    expect(cacheUntil(null, now)).toBe(now + UNKNOWN_TTL_MS);
    expect(cacheUntil({ status: 'active', expiresAt: '2026-10-16T12:00:30.000Z' }, now)).toBe(now + 30_000);
    expect(cacheUntil({ status: 'active', expiresAt: '2026-10-16T12:00:30.000Z' }, now, STALE_GRACE_MS)).toBe(
      now + 30_000,
    );
    // An ended publication has nothing left to expire.
    expect(cacheUntil({ status: 'expired', expiresAt: '2026-10-15T12:00:00.000Z' }, now)).toBe(
      now + TENANT_TTL_MS,
    );
  });
});
