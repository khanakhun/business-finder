import type { Asset, CtaAction, LocalizedText, Page, SiteLocale, SiteSpec } from '@bf/site-schema';
import { timeZoneOf } from '../format/hours.ts';
import { whatsappLink } from '../format/phone.ts';
import { uiStrings } from '../i18n/strings.ts';
import { PlainLink, ResponsiveImage } from './defaults.tsx';
import type { RenderContext, RenderOptions, ResolvedCta, ResolvedImage } from './types.ts';

/** A localized text in `locale`, else the site's default locale, else any (the validator requires every locale). */
export function pickText(text: LocalizedText | undefined, locale: SiteLocale, fallback: SiteLocale): string {
  if (!text) return '';
  return text[locale] ?? text[fallback] ?? Object.values(text).find((value) => value !== undefined) ?? '';
}

/**
 * A link the renderer may emit, else undefined: http(s), `tel:`, `mailto:`, or a same-site path, query or fragment
 * (`/carte`, never `//evil.example`). The schema checks links; this keeps a page safe regardless (`data:`,
 * `vbscript:` and protocol-relative links are dropped).
 */
export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (/^[/?#]/.test(href)) return /^\/[/\\]/.test(href) || href.includes('\\') ? undefined : href;
  try {
    return ['https:', 'http:', 'tel:', 'mailto:'].includes(new URL(href).protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

/** The default page URL: the default locale at the root, the others under `/<locale>`. */
export function defaultPageHref(page: Page, locale: SiteLocale, spec: SiteSpec): string {
  const prefix = locale === spec.defaultLocale ? '' : `/${locale}`;
  // A slug never starts with a slash (the schema's pattern); stripping one keeps `//host` out of every link.
  const slug = page.slug.replace(/^[/\\]+/, '');
  return slug ? `${prefix}/${slug}` : prefix || '/';
}

/** An OpenStreetMap link to the business (coordinates first, else its address): no tracking, no API key. */
export function mapLink(contact: SiteSpec['contact']): string | undefined {
  if (contact.geo) {
    const { lat, lng } = contact.geo;
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
  }
  if (contact.address)
    return `https://www.openstreetmap.org/search?query=${encodeURIComponent(contact.address.formatted)}`;
  return undefined;
}

/** The default action resolution: contact facts, the site's pages, or the allowlisted URL. Null when unresolvable. */
export function resolveCta(action: CtaAction, ctx: RenderContext): ResolvedCta | null {
  const { contact } = ctx.spec;
  const label = ctx.t(action.label);
  const to = (raw: string | undefined, external: boolean): ResolvedCta | null => {
    const href = safeHref(raw);
    return href ? { href, label, kind: action.kind, external } : null;
  };
  switch (action.kind) {
    case 'call':
      return to(contact.phone && `tel:${contact.phone.value}`, false);
    case 'email':
      return to(contact.email && `mailto:${contact.email.value}`, false);
    case 'whatsapp':
      return to(contact.whatsapp && whatsappLink(contact.whatsapp.value), true);
    case 'booking':
      return to(contact.bookingUrl?.value, true);
    case 'directions':
      return to(mapLink(contact), true);
    case 'page':
      return to(ctx.pageHref(action.pageId), false);
    case 'url':
      return to(action.url, true);
  }
}

/** An asset as an image: its resolved URLs, size, alt text in the locale and focal point. */
export function resolveImage(
  asset: Asset,
  ctx: Pick<RenderContext, 't'>,
  options: RenderOptions,
): ResolvedImage {
  const urls = options.assetsResolver?.(asset) ?? { src: asset.url };
  return {
    src: urls.src,
    srcSet: urls.srcSet,
    width: asset.width,
    height: asset.height,
    alt: ctx.t(asset.alt),
    objectPosition: asset.focalPoint
      ? `${Math.round(asset.focalPoint.x * 100)}% ${Math.round(asset.focalPoint.y * 100)}%`
      : undefined,
  };
}

/** The context every block receives for one page in one locale. */
export function createRenderContext(
  spec: SiteSpec,
  page: Page,
  locale: SiteLocale,
  options: RenderOptions = {},
): RenderContext {
  const assets = new Map(spec.assets.map((asset) => [asset.id, asset]));
  const pages = new Map(spec.pages.map((candidate) => [candidate.id, candidate]));
  const hrefForPage = options.hrefForPage ?? defaultPageHref;
  const t = (text: LocalizedText | undefined) => pickText(text, locale, spec.defaultLocale);
  const country = spec.contact.address?.country;
  const facts = new Map((options.facts?.facts ?? []).map((fact) => [fact.id, fact]));
  const ctx: RenderContext = {
    spec,
    page,
    locale,
    strings: uiStrings(locale),
    options,
    Image: options.imageComponent ?? ResponsiveImage,
    Link: options.linkComponent ?? PlainLink,
    t,
    image: (assetId) => {
      const asset = assetId ? assets.get(assetId) : undefined;
      return asset ? resolveImage(asset, { t }, options) : undefined;
    },
    cta: (action) => (action ? (options.ctaResolver ?? resolveCta)(action, ctx) : null),
    pageHref: (pageId, inLocale = locale) => {
      const target = pages.get(pageId);
      return target ? hrefForPage(target, inLocale, spec) : undefined;
    },
    fact: (factId) => facts.get(factId),
    country,
    timeZone: timeZoneOf(country),
  };
  return ctx;
}
