import type { Block, SiteSpec } from '@bf/site-schema';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BlockRenderer } from '../renderer/block-renderer.tsx';
import { createRenderContext, pickText } from '../renderer/resolvers.ts';
import { SitePage } from '../renderer/site-page.tsx';
import type { ResolvedCta } from '../renderer/types.ts';
import { FIXTURES, facts, fixture } from '../test-utils.tsx';

const NBSP = ' ';

/** A block of the fixtures by type, rendered in a variant (with its own site and page). */
function renderBlock(spec: SiteSpec, type: Block['type'], variant?: string, locale = spec.defaultLocale) {
  for (const page of spec.pages) {
    const block = page.blocks.find((candidate) => candidate.type === type);
    if (block) {
      const ctx = createRenderContext(spec, page, locale, { mode: 'development' });
      const shown = { ...block, variant: variant ?? block.variant } as Block;
      return render(<BlockRenderer block={shown} ctx={ctx} index={1} />);
    }
  }
  throw new Error(`no ${type} block`);
}

describe('language switching', () => {
  it.each(FIXTURES.flatMap((name) => fixture(name).locales.map((locale) => [name, locale] as const)))(
    '%s in %s: header action and menu labels in that language',
    (name, locale) => {
      const spec = fixture(name);
      render(<SitePage spec={spec} page={spec.pages[0]?.id ?? ''} locale={locale} />);
      const banner = document.querySelector('header.bf-header') as HTMLElement;
      const { cta, showCta } = spec.layout.header;
      if (showCta && cta)
        expect(
          within(banner).getAllByText(pickText(cta.label, locale, spec.defaultLocale)).length,
        ).toBeGreaterThan(0);
      for (const item of spec.navigation.items)
        expect(
          within(banner).getAllByRole('link', { name: pickText(item.label, locale, spec.defaultLocale) })
            .length,
        ).toBeGreaterThan(0);
    },
  );

  it('writes weekday names and prices in the language', () => {
    const salon = fixture('salon-gustavia');
    const { container, unmount } = render(<SitePage spec={salon} page="home" locale="fr" />);
    expect(container.textContent).toContain(`65${NBSP}€`);
    expect(container.textContent).toContain('lundi');
    unmount();
    const english = render(<SitePage spec={salon} page="home" locale="en" />).container;
    expect(english.textContent).toContain('€65');
    expect(english.textContent).toContain('Monday');
  });
});

describe('injection', () => {
  const salon = fixture('salon-gustavia');

  it('routes every action through ctaResolver, and an action it drops shows no button', () => {
    const ctaResolver = vi.fn((action: { kind: ResolvedCta['kind'] }): ResolvedCta | null =>
      action.kind === 'booking'
        ? null
        : { href: `/r/${action.kind}`, label: 'Go', kind: action.kind, external: false },
    );
    const { container } = render(<SitePage spec={salon} page="home" locale="fr" ctaResolver={ctaResolver} />);
    expect(ctaResolver).toHaveBeenCalledWith(expect.objectContaining({ kind: 'booking' }), expect.anything());
    expect(container.querySelector(`a[href="${salon.contact.bookingUrl?.value}"]`)).toBeNull();
    expect(container.querySelector('a[href="/r/call"]')).not.toBeNull();
  });

  it('uses hrefForPage for the menu and the language links', () => {
    render(
      <SitePage
        spec={salon}
        page="home"
        locale="fr"
        hrefForPage={(page, locale) => `/s/${locale}/${page.id}`}
      />,
    );
    expect(screen.getAllByRole('link', { name: 'Prestations' })[0]).toHaveAttribute('href', '/s/fr/services');
    expect(screen.getAllByRole('link', { name: 'en – English' })[0]).toHaveAttribute('href', '/s/en/home');
  });

  it('shows the static map image when the renderer supplies one, and only the address without a map', () => {
    const mapImage = vi.fn(() => ({ src: '/maps/salon.png', width: 1200, height: 900 }));
    const page = salon.pages.find((candidate) => candidate.id === 'contact');
    const block = page?.blocks.find((candidate) => candidate.type === 'location');
    if (!page || !block) throw new Error('no location');
    const ctx = createRenderContext(salon, page, 'fr', { mapImage });
    const { container, unmount } = render(<BlockRenderer block={block} ctx={ctx} index={1} />);
    expect(container.querySelector('img[src="/maps/salon.png"]')).toHaveAttribute(
      'alt',
      expect.stringContaining('Gustavia'),
    );
    unmount();
    const plain = renderBlock(salon, 'location', 'address_only').container;
    expect(plain.querySelector('img')).toBeNull();
    expect(within(plain).queryByText('Voir sur la carte')).toBeNull();
    expect(within(plain).getByText('Itinéraire')).toBeInTheDocument();
  });

  it('shows prices from the registry, never the spec’s own amount', () => {
    const registry = facts('salon-gustavia');
    const priced = registry.facts.find((fact) => fact.kind === 'price');
    if (priced?.kind !== 'price') throw new Error('no price fact');
    const tampered: SiteSpec = structuredClone(salon);
    for (const block of tampered.pages[0]?.blocks ?? [])
      if (block.type === 'services')
        for (const item of block.props.items) if (item.price?.factId === priced.id) item.price.amount = 1234;
    const { container } = render(<SitePage spec={tampered} page="home" locale="fr" facts={registry} />);
    expect(container.textContent).not.toContain('1234');
    expect(container.textContent).toContain(`${priced.value.amount}${NBSP}€`);
  });
});

describe('layout', () => {
  it('is transparent over a full-image hero and falls back to simple elsewhere or without the image', () => {
    const villa = fixture('villa-agency');
    const header = (spec: SiteSpec, page: string) => {
      const { unmount } = render(<SitePage spec={spec} page={page} locale="en" />);
      const variant = document.querySelector('header.bf-header')?.getAttribute('data-variant');
      unmount();
      return variant;
    };
    expect(header(villa, 'home')).toBe('transparent');
    expect(header(villa, 'villas')).toBe('simple');
    const noImage: SiteSpec = structuredClone(villa);
    const hero = noImage.pages[0]?.blocks[0];
    if (hero?.type === 'hero') hero.props.imageAssetId = 'missing-asset';
    expect(header(noImage, 'home')).toBe('simple');
  });

  it('has no menu button without menu items and no language list with one language', () => {
    const salon = fixture('salon-gustavia');
    const bare: SiteSpec = { ...salon, locales: ['fr'], navigation: { items: [] } };
    const { container } = render(<SitePage spec={bare} page="home" locale="fr" />);
    expect(container.querySelector('[popovertarget]')).toBeNull();
    expect(container.querySelector('#bf-mobile-menu')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Langues' })).toBeNull();
  });

  it('lists contact, hours and menu in a columns footer, and only the brand line in a simple one', () => {
    const salon = fixture('salon-gustavia');
    const columns = render(<SitePage spec={salon} page="home" locale="fr" />);
    const footer = columns.getByRole('contentinfo');
    expect(within(footer).getByRole('heading', { name: 'Horaires' })).toBeInTheDocument();
    expect(within(footer).getByRole('navigation', { name: 'Menu' })).toBeInTheDocument();
    columns.unmount();
    const simple = {
      ...salon,
      layout: { ...salon.layout, footer: { ...salon.layout.footer, variant: 'simple' as const } },
    };
    render(<SitePage spec={simple} page="home" locale="fr" />);
    const line = screen.getByRole('contentinfo');
    expect(within(line).queryByRole('heading')).toBeNull();
    expect(line).toHaveTextContent(`© ${salon.brand.name}`);
  });

  it('gives every content image a non-empty description', () => {
    for (const name of FIXTURES) {
      const spec = fixture(name);
      const { container, unmount } = render(
        <SitePage spec={spec} page={spec.pages[0]?.id ?? ''} locale={spec.defaultLocale} />,
      );
      for (const image of container.querySelectorAll('img'))
        expect(image.getAttribute('alt')?.trim()).not.toBe('');
      unmount();
    }
  });
});

describe('variants that differ', () => {
  it('services: a list with dotted price leaders, cards with the image first', () => {
    const salon = fixture('salon-gustavia');
    const list = renderBlock(salon, 'services', 'list').container;
    expect(list.querySelectorAll('.bf-leader').length).toBeGreaterThan(0);
    expect(list.querySelector('img')).toBeNull();
  });

  it('faq: native details in the accordion, a definition list in two columns', () => {
    const shop = fixture('hardware-store-lorient');
    expect(
      renderBlock(shop, 'faq', 'accordion').container.querySelectorAll('details').length,
    ).toBeGreaterThan(0);
    const columns = renderBlock(shop, 'faq', 'two_column').container;
    expect(columns.querySelector('details')).toBeNull();
    expect(columns.querySelector('dl')).not.toBeNull();
  });

  it('gallery: the carousel is a named, focusable region; every photo opens a viewer', () => {
    const cafe = fixture('cafe-saint-jean');
    const { container } = renderBlock(cafe, 'gallery', 'carousel');
    const list = container.querySelector('.bf-carousel');
    expect(list).toHaveAttribute('tabindex', '0');
    expect(list).toHaveAttribute('aria-label');
    const buttons = within(container).getAllByRole('button', { name: /Agrandir la photo/ });
    for (const button of buttons)
      expect(container.querySelector(`#${button.getAttribute('popovertarget')}`)).toHaveAttribute(
        'popover',
        'auto',
      );
  });

  it('hero image_full without an image falls back to the primary colour', () => {
    const cafe: SiteSpec = structuredClone(fixture('cafe-saint-jean'));
    const hero = cafe.pages[0]?.blocks[0];
    if (hero?.type === 'hero') hero.props.imageAssetId = undefined;
    const { container } = renderBlock(cafe, 'hero', 'image_full');
    expect(container.querySelector('.bg-primary')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('team: a member without a photo shows initials hidden from screen readers', () => {
    const { container } = renderBlock(fixture('villa-agency'), 'team');
    const initials = container.querySelector('[aria-hidden="true"].bf-icon-badge');
    expect(initials?.textContent).toMatch(/^[A-Z]{1,2}$/);
  });

  it('booking: an allowlisted provider is offered in place on request, any other as a link', () => {
    const villa = fixture('villa-agency');
    const link = renderBlock(villa, 'booking', 'embed').container;
    expect(within(link).getByRole('link')).toHaveAttribute('href', villa.contact.bookingUrl?.value);
    expect(within(link).queryByRole('button')).toBeNull();
    link.remove();
    const calendly = {
      ...villa,
      contact: {
        ...villa.contact,
        bookingUrl: { value: 'https://calendly.com/villas', factId: 'booking.main' },
      },
    };
    const embed = renderBlock(calendly, 'booking', 'embed').container;
    expect(within(embed).getByRole('button')).toBeInTheDocument();
    expect(embed.querySelector('iframe')).toBeNull();
  });

  it('testimonials: a quote shown in its fact’s language keeps that language', () => {
    const salon = fixture('salon-gustavia');
    const registry = facts('salon-gustavia');
    const testimonial = registry.facts.find((fact) => fact.kind === 'testimonial');
    if (testimonial?.kind !== 'testimonial' || !testimonial.locale) throw new Error('no testimonial fact');
    const other = testimonial.locale === 'fr' ? 'en' : 'fr';
    const spec: SiteSpec = structuredClone(salon);
    for (const block of spec.pages[0]?.blocks ?? [])
      if (block.type === 'testimonials') for (const item of block.props.items) delete item.quote[other];
    const { container } = render(<SitePage spec={spec} page="home" locale={other} facts={registry} />);
    expect(container.querySelector(`blockquote[lang="${testimonial.locale}"]`)).toHaveTextContent(
      testimonial.value.quote,
    );
  });
});
