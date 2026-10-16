import { describe, expect, it } from 'vitest';
import { fixture, TEST_CSS } from '../test-utils.tsx';
import { renderStaticPage, renderStaticSite, staticPath } from './render-static-page.tsx';

const salon = fixture('salon-gustavia');

describe('renderStaticPage', () => {
  it('renders a complete document: language, title, description, robots, alternates, fonts, stylesheet', () => {
    const { html, css } = renderStaticPage(salon, 'services', 'en', {
      css: TEST_CSS,
      origin: 'https://salon.sites.test',
    });
    const services = salon.pages[1];
    expect(css).toBe(TEST_CSS);
    expect(html.startsWith('<!doctype html>\n<html lang="en"')).toBe(true);
    expect(html).toContain(`<title>${services?.seo.title.en}</title>`);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain(`<link rel="canonical" href="https://salon.sites.test/en/${services?.slug}">`);
    expect(html).toContain(
      `<link rel="alternate" hreflang="fr" href="https://salon.sites.test/${services?.slug}">`,
    );
    expect(html).toContain(
      `<link rel="alternate" hreflang="x-default" href="https://salon.sites.test/${services?.slug}">`,
    );
    expect(html).toMatch(
      /<link rel="preload" href="\/fonts\/cormorant-garamond-latin-wght-normal\.woff2" as="font" type="font\/woff2" crossorigin>/,
    );
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(html).not.toContain('<script src');
  });

  it('inlines the stylesheet on request and resolves the fonts next to an absolute stylesheet', () => {
    const { html } = renderStaticPage(salon, 'home', 'fr', {
      css: '.a{b:c}</style><script>x</script>',
      inlineCss: true,
    });
    expect(html).toContain('<style>.a{b:c}<\\/style><script>x</script></style>');
    const cdn = renderStaticPage(salon, 'home', 'fr', {
      css: TEST_CSS,
      stylesheetHref: 'https://cdn.test/v1/styles.css',
    }).html;
    expect(cdn).toContain('href="https://cdn.test/v1/fonts/cormorant-garamond-latin-wght-normal.woff2"');
  });

  it('describes the business as schema.org data, escaping "<" so no text can close the script', () => {
    const spec = { ...salon, brand: { ...salon.brand, name: 'Salon </script><script>alert(1)</script>' } };
    const { html } = renderStaticPage(spec, 'home', 'fr', { css: TEST_CSS });
    const json = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)?.[1] ?? '';
    expect(json).not.toContain('<');
    expect(JSON.parse(json)).toMatchObject({
      '@type': 'LocalBusiness',
      name: spec.brand.name,
      telephone: salon.contact.phone?.value,
    });
    expect(html).toContain('<title>');
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('is deterministic and leaves out robots on a published site', () => {
    const published = { ...salon, settings: { ...salon.settings, noindex: false } };
    const once = renderStaticPage(published, 'home', 'fr', { css: TEST_CSS }).html;
    expect(once).toBe(renderStaticPage(published, 'home', 'fr', { css: TEST_CSS }).html);
    expect(once).not.toContain('name="robots"');
  });

  it('throws for a page the site does not have', () => {
    expect(() => renderStaticPage(salon, 'nowhere', 'fr', { css: TEST_CSS })).toThrow(/no page "nowhere"/);
  });
});

describe('renderStaticSite', () => {
  it('writes every page in every locale at its URL path', () => {
    const { files } = renderStaticSite(salon, { css: TEST_CSS });
    const slugs = salon.pages.map((page) => page.slug).filter(Boolean);
    expect([...files.keys()].sort()).toEqual(
      [
        'index.html',
        ...slugs.map((slug) => `${slug}/index.html`),
        'en/index.html',
        ...slugs.map((slug) => `en/${slug}/index.html`),
      ].sort(),
    );
    const home = salon.pages[0];
    if (home) expect(staticPath(salon, home, 'en')).toBe('en/index.html');
  });
});
