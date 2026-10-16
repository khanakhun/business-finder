import AxeBuilder from '@axe-core/playwright';
import { signInternalRequest } from '@bf/contracts';
import { closeDb } from '@bf/db';
import { sites } from '@bf/db/schema';
import { expect, test } from '@playwright/test';
import { eq, sql } from 'drizzle-orm';
import { canonicalUrl, REVALIDATE_SECRET, sitesPort, siteUrl } from './env.ts';
import { AGENCY, addVersion, db, fixture, SLUGS } from './seed.ts';

const salon = fixture('salon-gustavia') as {
  defaultLocale: string;
  locales: string[];
  pages: { id: string; slug: string; seo: { title: Record<string, string> } }[];
};
const services = salon.pages.find((page) => page.slug !== '');
const other = salon.locales.find((locale) => locale !== salon.defaultLocale) ?? 'en';

async function revalidateTags(tags: string[]): Promise<number> {
  const body = JSON.stringify({ tags });
  const authorization = await signInternalRequest(
    { method: 'POST', path: '/api/revalidate', body },
    { secret: REVALIDATE_SECRET },
  );
  const response = await fetch(`http://127.0.0.1:${sitesPort}/api/revalidate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    body,
  });
  return response.status;
}

test('renders an active preview: language, SEO rules, banner, strict CSP and no indexing', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  const response = await page.goto(siteUrl(SLUGS.active));
  expect(response?.status()).toBe(200);
  const headers = response?.headers() ?? {};
  expect(headers['x-robots-tag']).toBe('noindex, nofollow');
  expect(headers['content-security-policy']).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-content-type-options']).toBe('nosniff');
  await expect(page.locator('html')).toHaveAttribute('lang', salon.defaultLocale);
  await expect(page).toHaveTitle(salon.pages[0]?.seo.title[salon.defaultLocale] ?? '');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('.bf-preview-banner')).toContainText(AGENCY.name);
  await expect(page.locator(`link[rel="alternate"][hreflang="${other}"]`)).toHaveAttribute(
    'href',
    canonicalUrl(SLUGS.active, `/${other}`),
  );
  // Styled by the block library's stylesheet, nothing refused by the policy.
  await expect(page.locator('.bf-site')).toHaveCSS('display', /block|flex|grid/);
  expect(violations).toEqual([]);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
});

test('serves the other language under its prefix, and keeps the page when switching', async ({ page }) => {
  const response = await page.goto(siteUrl(SLUGS.active, `/${other}/${services?.slug}`));
  expect(response?.status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('lang', other);
  await expect(page).toHaveTitle(services?.seo.title[other] ?? '');
  await expect(page.locator(`link[rel="alternate"][hreflang="${salon.defaultLocale}"]`)).toHaveAttribute(
    'href',
    canonicalUrl(SLUGS.active, `/${services?.slug}`),
  );
});

test('closes previews to crawlers but our screenshot bot, and has no sitemap', async ({ request }) => {
  const robots = await request.get(siteUrl(SLUGS.active, '/robots.txt'));
  expect(await robots.text()).toBe('User-agent: BusinessFinderBot\nAllow: /\n\nUser-agent: *\nDisallow: /\n');
  expect((await request.get(siteUrl(SLUGS.active, '/sitemap.xml'))).status()).toBe(404);
});

test('answers 404 for an unknown host or page, and 410 for an ended preview with the agency', async ({
  page,
  request,
}) => {
  const unknown = await request.get(siteUrl('nobody-x1y2z3'));
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()['x-robots-tag']).toBe('noindex, nofollow');
  const missing = await page.goto(siteUrl(SLUGS.active, '/no-such-page'));
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole('link', { name: /accueil|home/i })).toHaveAttribute('href', '/');
  for (const slug of [SLUGS.expired, SLUGS.unpublished]) {
    const gone = await page.goto(siteUrl(slug));
    expect(gone?.status()).toBe(410);
    await expect(page.getByRole('link', { name: new RegExp(AGENCY.name) })).toHaveAttribute(
      'href',
      AGENCY.url,
    );
  }
});

test('sends one view beacon without cookies, with the signed token and the campaign', async ({
  page,
  context,
}) => {
  // A cookie the browser would send cross-site if it could: the beacon carries none.
  await context.addCookies([
    { name: 'session', value: 'x', domain: 'api.e2e.localhost', path: '/', sameSite: 'None', secure: false },
  ]);
  const beacon = page.waitForRequest((request) => request.url().endsWith('/v1/public/sites/views'));
  await page.route('**/v1/public/sites/views', (route) => route.fulfill({ status: 204 }));
  await page.goto(siteUrl(SLUGS.active, '/?c=spring-mail'));
  const sent = await beacon;
  expect(sent.method()).toBe('POST');
  expect(await sent.headerValue('cookie')).toBeNull();
  expect(await sent.headerValue('content-type')).toMatch(/^text\/plain/);
  const body = JSON.parse(sent.postData() ?? '{}');
  expect(body).toMatchObject({ pageId: salon.pages[0]?.id, locale: salon.defaultLocale, c: 'spring-mail' });
  expect(body.token).toMatch(/^v1\./);
});

test('sends no beacon when the browser asks for privacy (GPC)', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'globalPrivacyControl', { value: true }));
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/v1/public/sites/views')) sent.push(request.url());
  });
  await page.goto(siteUrl(SLUGS.active));
  await page.waitForLoadState('networkidle');
  expect(sent).toEqual([]);
});

test('answers a missing page with a readable 404 (no JavaScript needed), and drops the default prefix', async ({
  request,
}) => {
  const missing = await request.get(siteUrl(SLUGS.active, `/${other}/no-such-page`));
  expect(missing.status()).toBe(404);
  const html = await missing.text();
  expect(html).toContain(`lang="${other}"`);
  expect(html).toMatch(/Page not found/);
  expect(html).toContain(`href="/${other}"`);
  const prefixed = await request.get(siteUrl(SLUGS.active, `/${salon.defaultLocale}/${services?.slug}?c=x`), {
    maxRedirects: 0,
  });
  expect(prefixed.status()).toBe(308);
  expect(prefixed.headers().location).toMatch(new RegExp(`/${services?.slug}\\?c=x$`));
});

test('refuses unsigned revalidations, and shows a new version or an ended preview after a signed one', async ({
  page,
}) => {
  expect(
    (
      await fetch(`http://127.0.0.1:${sitesPort}/api/revalidate`, {
        method: 'POST',
        body: JSON.stringify({ tags: ['host:x.sites.localhost'] }),
      })
    ).status,
  ).toBe(401);
  const client = db();
  try {
    await page.goto(siteUrl(SLUGS.revalidated));
    const [site] = await client.select().from(sites).where(eq(sites.slug, SLUGS.revalidated));
    if (!site) throw new Error('no e2e site');
    const spec = fixture('salon-gustavia') as typeof salon;
    const title = 'Salon Lumière — nouvelle version';
    const home = spec.pages[0];
    if (home) home.seo.title[salon.defaultLocale] = title;
    const versionId = await addVersion(client, site.id, spec as unknown as Record<string, unknown>, 2);
    await client.execute(
      sql`UPDATE site_publications SET version_id = ${versionId} WHERE site_id = ${site.id} AND status = 'active'`,
    );
    // Cached until the API's revalidation.
    await page.goto(siteUrl(SLUGS.revalidated));
    await expect(page).not.toHaveTitle(title);
    expect(await revalidateTags([`site:${site.id}`])).toBe(200);
    await page.goto(siteUrl(SLUGS.revalidated));
    await expect(page).toHaveTitle(title);
    // Unpublished: the next request after the revalidation is a 410 (the proxy reads the same cache).
    await client.execute(
      sql`UPDATE site_publications SET status = 'unpublished', ended_at = now() WHERE site_id = ${site.id} AND status = 'active'`,
    );
    expect(await revalidateTags([`host:${SLUGS.revalidated}.sites.localhost`])).toBe(200);
    expect((await page.goto(siteUrl(SLUGS.revalidated)))?.status()).toBe(410);
  } finally {
    await closeDb(client);
  }
});

test('ignores a visitor’s own proxy headers and look-alike internal paths', async ({ request }) => {
  const spoofed = await request.get(siteUrl('nobody-x1y2z3', '/-/x/y'), {
    headers: { 'x-bf-hostname': `${SLUGS.active}.sites.localhost`, 'x-bf-path': '/', 'x-nonce': 'abc' },
  });
  expect(spoofed.status()).toBe(404);
  expect(await spoofed.text()).not.toContain('Salon');
  const lookAlike = await request.get(siteUrl(SLUGS.active, '/api/revalidatex/y'));
  expect(lookAlike.status()).toBe(404);
  // A path like any other: not a page of the site, so its 404 page (with that page's own strict policy).
  expect(lookAlike.headers()['content-security-policy']).toContain("default-src 'none'");
  // The internal routes answer on the internal address only: under a site's hostname they are site paths.
  for (const path of ['/health/ready', '/api/revalidate']) {
    const internal = await request.get(siteUrl(SLUGS.active, path));
    expect(internal.status()).toBe(404);
    expect(await internal.text()).not.toContain('"ok"');
  }
  const big = await fetch(`http://127.0.0.1:${sitesPort}/api/revalidate`, {
    method: 'POST',
    headers: { Authorization: `Bearer 1.${'a'.repeat(16)}.${'0'.repeat(64)}` },
    body: 'x'.repeat(20_000),
  });
  expect(big.status).toBe(413);
});

test('serves the block library’s stylesheet and preloaded fonts, and nothing else under /_bf', async ({
  page,
  request,
}) => {
  await page.goto(siteUrl(SLUGS.active));
  const files = await page
    .locator('link[rel="preload"][as="font"], link[rel="stylesheet"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  expect(files.length).toBeGreaterThanOrEqual(3);
  for (const file of files) {
    const response = await request.get(siteUrl(SLUGS.active, file));
    expect(response.status(), file).toBe(200);
    expect(response.headers()['cache-control']).toContain('public');
  }
  for (const path of ['/_bf/nothing-here', '/_bf/fonts/missing.woff2']) {
    const missing = await request.get(siteUrl(SLUGS.active, path));
    expect(missing.status(), path).toBe(404);
    expect(await missing.text()).not.toContain('Salon');
  }
});

test('offers a preview’s claim and opt-out in its banner, passing the e-mail’s signed reference on', async ({
  page,
}) => {
  await page.goto(siteUrl(SLUGS.active, '/?r=v1.e2e-reference.signature'));
  const banner = page.locator('.bf-preview-banner');
  await expect(banner.getByRole('link', { name: /C’est mon entreprise/ })).toHaveAttribute('href', '/claim');
  await expect(banner.getByRole('link', { name: /Pas intéressé/ })).toHaveAttribute(
    'href',
    '/opt-out?r=v1.e2e-reference.signature',
  );
  // Keyboard order: the skip link first, then the banner's actions.
  await page.keyboard.press('Tab');
  await expect(page.locator('.bf-skip')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(banner.getByRole('link', { name: /C’est mon entreprise/ })).toBeFocused();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
});
