import { BLOCK_TYPES, type Block, blockVariants, type SiteSpec } from '@bf/site-schema';
import { render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FIXTURES, facts, fixture } from '../test-utils.tsx';
import { BlockRenderer, blockTones, UnknownBlockError } from './block-renderer.tsx';
import {
  createRenderContext,
  defaultPageHref,
  mapLink,
  pickText,
  resolveCta,
  safeHref,
} from './resolvers.ts';
import { SitePage } from './site-page.tsx';
import type { SiteImageProps } from './types.ts';

const salon = fixture('salon-gustavia');

/** The first block of each type in the fixtures (they cover every type), with its page and site. */
const examples = new Map<string, { block: Block; spec: SiteSpec; pageId: string }>();
for (const name of FIXTURES) {
  const spec = fixture(name);
  for (const page of spec.pages)
    for (const block of page.blocks)
      if (!examples.has(block.type)) examples.set(block.type, { block, spec, pageId: page.id });
}

describe('SitePage', () => {
  it.each(
    FIXTURES.flatMap((name) =>
      fixture(name).pages.flatMap((page) =>
        fixture(name).locales.map((locale) => [name, page.id, locale] as const),
      ),
    ),
  )('%s / %s / %s renders with one h1, landmarks and a skip link first', (name, pageId, locale) => {
    const { container } = render(
      <SitePage spec={fixture(name)} page={pageId} locale={locale} mode="development" />,
    );
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelector('header.bf-header')).not.toBeNull();
    expect(container.querySelector('footer')).not.toBeNull();
    const firstLink = container.querySelector('a');
    expect(firstLink).toHaveAttribute('href', '#main');
    expect(container.querySelector('.bf-site')).toHaveAttribute('lang', locale);
    for (const image of container.querySelectorAll('img')) expect(image).toHaveAttribute('alt');
    // Headings never skip a level (h1, then h2 sections, then h3 items).
    const levels = [...container.querySelectorAll('main h1, main h2, main h3')].map((h) =>
      Number(h.tagName[1]),
    );
    for (const [i, level] of levels.entries())
      if (i > 0) expect(level - (levels[i - 1] ?? 1)).toBeLessThanOrEqual(1);
  });

  it('switches language: texts, links and the interface words', () => {
    render(<SitePage spec={salon} page="home" locale="en" />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      pickText(
        salon.pages[0]?.blocks[0]?.props &&
          (salon.pages[0].blocks[0] as Extract<Block, { type: 'hero' }>).props.title,
        'en',
        'fr',
      ),
    );
    expect(screen.getByText('Skip to content')).toBeInTheDocument();
    const languages = screen.getAllByRole('list', { name: 'Languages' })[0] as HTMLElement;
    expect(within(languages).getByRole('link', { name: 'fr – Français' })).toHaveAttribute('href', '/');
    expect(within(languages).getByRole('link', { name: 'en – English' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('is deterministic: the same input gives the same HTML', () => {
    const html = () =>
      renderToStaticMarkup(
        <SitePage spec={salon} page="contact" locale="fr" facts={facts('salon-gustavia')} />,
      );
    expect(html()).toBe(html());
  });

  it('shows the preview banner, naming the agency when given', () => {
    render(<SitePage spec={salon} page="home" locale="fr" agencyName="Agence Exemple" />);
    expect(screen.getByRole('complementary', { name: 'Aperçu' })).toHaveTextContent(
      /proposé par Agence Exemple/,
    );
    const { container } = render(
      <SitePage
        spec={{ ...salon, settings: { ...salon.settings, previewBanner: false } }}
        page="home"
        locale="fr"
      />,
    );
    expect(container.querySelector('.bf-preview-banner')).toBeNull();
  });

  it('shows the banner and disables the contact form on a preview, whatever the spec says', () => {
    const official = { ...salon, settings: { ...salon.settings, previewBanner: false, noindex: false } };
    const { container } = render(<SitePage spec={official} page="contact" locale="fr" preview />);
    expect(container.querySelector('.bf-preview-banner')).not.toBeNull();
    for (const form of container.querySelectorAll('form')) expect(form).not.toHaveAttribute('action');
  });

  it('prefixes the DOM ids taken from block ids (a block id never shadows a global or a layout id)', () => {
    const spec = structuredClone(salon);
    const hero = spec.pages[0]?.blocks[0];
    if (hero) hero.id = '__next_f';
    const { container } = render(<SitePage spec={spec} page="home" locale="fr" />);
    expect(container.querySelector('[id="__next_f"]')).toBeNull();
    expect(container.querySelector('[id="b-__next_f:title"]')).not.toBeNull();
    for (const section of container.querySelectorAll('section[id]')) expect(section.id).toMatch(/^b-/);
  });

  it('injects the image and link components; the hero image is a priority, the others lazy', () => {
    const images: SiteImageProps[] = [];
    const Image = (props: SiteImageProps) => {
      images.push(props);
      return <img src={props.src} alt={props.alt} />;
    };
    const Link = ({ href, children }: { href: string; children: React.ReactNode }) => (
      <a href={`/x${href}`}>{children}</a>
    );
    render(
      <SitePage
        spec={fixture('cafe-saint-jean')}
        page="home"
        locale="fr"
        imageComponent={Image}
        linkComponent={Link}
        assetsResolver={(asset) => ({ src: `/cdn/${asset.id}.jpg`, srcSet: `/cdn/${asset.id}-800.jpg 800w` })}
      />,
    );
    expect(images[0]).toMatchObject({
      src: '/cdn/img-cafe-1.jpg',
      priority: true,
      srcSet: '/cdn/img-cafe-1-800.jpg 800w',
    });
    expect(images.slice(1).every((image) => !image.priority)).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Carte' })[0]).toHaveAttribute('href', '/x/carte');
  });

  it('renders the default image lazily with its size (no layout shift)', () => {
    const { container } = render(<SitePage spec={fixture('cafe-saint-jean')} page="home" locale="fr" />);
    const [hero, next] = container.querySelectorAll('main img');
    expect(hero).toHaveAttribute('loading', 'eager');
    expect(hero).toHaveAttribute('fetchpriority', 'high');
    expect(next).toHaveAttribute('loading', 'lazy');
    expect(next).toHaveAttribute('width', '1600');
    expect(next).toHaveAttribute('height', '1067');
  });
});

describe('blocks', () => {
  it('covers every block type with a fixture example', () => {
    expect([...examples.keys()].sort()).toEqual([...BLOCK_TYPES].sort());
  });

  it.each(BLOCK_TYPES.flatMap((type) => blockVariants(type).map((variant) => [type, variant] as const)))(
    '%s renders its %s variant',
    (type, variant) => {
      const example = examples.get(type);
      if (!example) throw new Error(`no example of ${type}`);
      const { spec, pageId } = example;
      const page = spec.pages.find((candidate) => candidate.id === pageId) ?? spec.pages[0];
      if (!page) throw new Error('no page');
      const ctx = createRenderContext(spec, page, spec.defaultLocale, { mode: 'development' });
      const block = { ...example.block, variant } as Block;
      const { container } = render(<BlockRenderer block={block} ctx={ctx} index={1} tone="alt" />);
      const section = container.querySelector('section');
      expect(section).toHaveAttribute('data-block', type);
      expect(section).toHaveAttribute('data-variant', variant);
      expect(section?.textContent?.trim()).not.toBe('');
    },
  );

  it('throws on an unknown block in development and skips it with a logged error in production', () => {
    const page = salon.pages[0];
    if (!page) throw new Error('no page');
    const unknown = { id: 'what-12345', type: 'carousel3d', variant: 'x', props: {} } as unknown as Block;
    const dev = createRenderContext(salon, page, 'fr', { mode: 'development' });
    expect(() => renderToStaticMarkup(<BlockRenderer block={unknown} ctx={dev} index={1} />)).toThrow(
      UnknownBlockError,
    );
    const logger = { error: vi.fn() };
    const prod = createRenderContext(salon, page, 'fr', { logger });
    expect(renderToStaticMarkup(<BlockRenderer block={unknown} ctx={prod} index={1} />)).toBe('');
    expect(logger.error).toHaveBeenCalledWith(
      'site-blocks: unknown block type skipped',
      expect.objectContaining({ blockType: 'carousel3d' }),
    );
  });

  it('alternates section tones after the hero', () => {
    const page = salon.pages[0];
    expect(blockTones(page?.blocks ?? [])).toEqual([undefined, 'alt', 'base', 'alt', 'base']);
  });

  it('shows prices and quotes from the fact registry, and labels a translated quote', () => {
    const registry = facts('salon-gustavia');
    const priceFact = registry.facts.find((fact) => fact.kind === 'price');
    if (priceFact?.kind !== 'price') throw new Error('no price fact');
    const tampered: SiteSpec = structuredClone(salon);
    for (const block of tampered.pages[0]?.blocks ?? [])
      if (block.type === 'services')
        for (const item of block.props.items) if (item.price?.factId === priceFact.id) item.price.amount = 1;
    const { container } = render(<SitePage spec={tampered} page="home" locale="fr" facts={registry} />);
    expect(container.textContent).toContain(`${priceFact.value.amount} €`);
    const testimonial = registry.facts.find((fact) => fact.kind === 'testimonial');
    const other = testimonial?.locale === 'fr' ? 'en' : 'fr';
    render(<SitePage spec={salon} page="home" locale={other} facts={registry} />);
    expect(screen.getAllByText(other === 'fr' ? 'Traduit' : 'Translated').length).toBeGreaterThan(0);
  });

  it('renders rich text with links to the site pages and never raw HTML', () => {
    const spec: SiteSpec = structuredClone(fixture('hardware-store-lorient'));
    const page = spec.pages[1];
    const block = page?.blocks.find((candidate) => candidate.type === 'rich_text');
    if (block?.type !== 'rich_text' || !page) throw new Error('no rich text');
    block.props.body = { fr: 'Voir **notre** [accueil](page:home).\n\n- un\n- deux <b>x</b>', en: 'x' };
    const ctx = createRenderContext(spec, page, 'fr', {});
    const { container } = render(<BlockRenderer block={block} ctx={ctx} index={2} />);
    expect(within(container).getByRole('link', { name: 'accueil' })).toHaveAttribute('href', '/');
    expect(container.querySelector('strong')).toHaveTextContent('notre');
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('resolvers', () => {
  const page = salon.pages[0];
  if (!page) throw new Error('no page');
  const ctx = createRenderContext(salon, page, 'fr', {});
  const label = { fr: 'Go', en: 'Go' };

  it('resolves every action kind from the contact facts and the pages', () => {
    expect(resolveCta({ kind: 'call', label }, ctx)?.href).toBe(`tel:${salon.contact.phone?.value}`);
    expect(resolveCta({ kind: 'email', label }, ctx)?.href).toBe(`mailto:${salon.contact.email?.value}`);
    expect(resolveCta({ kind: 'booking', label }, ctx)).toMatchObject({
      href: salon.contact.bookingUrl?.value,
      external: true,
    });
    expect(resolveCta({ kind: 'directions', label }, ctx)?.href).toMatch(
      /^https:\/\/www\.openstreetmap\.org\/\?mlat=/,
    );
    expect(resolveCta({ kind: 'page', label, pageId: 'contact' }, ctx)).toMatchObject({
      href: '/contact',
      external: false,
    });
    expect(resolveCta({ kind: 'url', label, url: 'https://salon-lumiere.example/' }, ctx)?.href).toBe(
      'https://salon-lumiere.example/',
    );
  });

  it('resolves nothing for a channel the business does not publish or a missing page', () => {
    expect(resolveCta({ kind: 'whatsapp', label }, ctx)).toBeNull();
    expect(resolveCta({ kind: 'page', label, pageId: 'gone' }, ctx)).toBeNull();
    const noAddress = {
      ...salon.contact,
      geo: undefined,
      address: undefined,
    } as unknown as SiteSpec['contact'];
    expect(mapLink(noAddress)).toBeUndefined();
  });

  it('serves the default locale at the root and the others under their prefix', () => {
    const services = salon.pages[1];
    if (!services) throw new Error('no page');
    expect(defaultPageHref(page, 'fr', salon)).toBe('/');
    expect(defaultPageHref(page, 'en', salon)).toBe('/en');
    expect(defaultPageHref(services, 'en', salon)).toBe(`/en/${services.slug}`);
  });

  it('falls back to the default locale, then any', () => {
    expect(pickText({ fr: 'Bonjour' }, 'en', 'fr')).toBe('Bonjour');
    expect(pickText({ de: 'Hallo' }, 'en', 'fr')).toBe('Hallo');
    expect(pickText(undefined, 'en', 'fr')).toBe('');
  });
});

describe('safeHref', () => {
  it.each([
    'https://calendly.com/salon',
    'http://localhost:3100/carte',
    'tel:+590590000101',
    'mailto:bonjour@salon.example',
    '/carte',
    '/en/menu',
    '#contact',
    '?page=menu',
  ])('keeps %s', (href) => {
    expect(safeHref(href)).toBe(href);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example',
    '/\\evil.example',
    '/\\/evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    'java\tscript:alert(1)',
    'evil.example',
    '',
    undefined,
  ])('drops %s', (href) => {
    expect(safeHref(href)).toBeUndefined();
  });

  it('keeps a slug from making a protocol-relative page link, and drops unsafe CTA links', () => {
    const page = { ...(salon.pages[1] as SiteSpec['pages'][number]), slug: '/evil.example' };
    expect(defaultPageHref(page, 'fr', salon)).toBe('/evil.example');
    expect(defaultPageHref({ ...page, slug: '//evil.example' }, 'en', salon)).toBe('/en/evil.example');
    const spec = structuredClone(salon);
    if (spec.contact.bookingUrl) spec.contact.bookingUrl.value = 'javascript:alert(1)';
    const ctx = createRenderContext(spec, spec.pages[0] as SiteSpec['pages'][number], 'fr', {});
    expect(resolveCta({ kind: 'booking', label: { fr: 'Réserver', en: 'Book' } }, ctx)).toBeNull();
    expect(
      resolveCta({ kind: 'url', url: 'data:text/html,x', label: { fr: 'Voir', en: 'See' } } as never, ctx),
    ).toBeNull();
  });
});

describe('links of an unvalidated spec', () => {
  it('never leaves the site through a page link, and derived ids never collide with block ids', () => {
    const spec = structuredClone(salon);
    const target = spec.pages[1];
    if (target) target.slug = '\t/evil.example';
    const hero = spec.pages[0]?.blocks[0];
    const next = spec.pages[0]?.blocks[1];
    if (hero && next) next.id = `${hero.id}-title`;
    const { container } = render(<SitePage spec={spec} page="home" locale="fr" />);
    for (const link of container.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') ?? '';
      expect(
        new URL(href, 'https://site.example').origin === 'https://site.example' ||
          /^(https?|tel|mailto):/.test(href),
      ).toBe(true);
      expect(href).not.toMatch(/evil\.example/);
    }
    const ids = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});
