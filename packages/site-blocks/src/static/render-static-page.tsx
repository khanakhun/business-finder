import { readFileSync } from 'node:fs';
import {
  onColor,
  type Page,
  type SiteLocale,
  SiteLocaleSchema,
  type SiteSpec,
  SiteSpecSchema,
} from '@bf/site-schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { pairPreloads } from '../fonts/families.ts';
import { defaultPageHref, pickText } from '../renderer/resolvers.ts';
import { findPage, SitePage } from '../renderer/site-page.tsx';
import type { RenderOptions } from '../renderer/types.ts';

// The static renderer (BF-034): a page as a complete HTML document, rendered with react-dom/server from the same
// components as apps/sites and the editor. `sitekit render/screenshot` (BF-042), the quality gates and this
// package's visual, accessibility and Lighthouse suites use it. Node only (it reads the built stylesheet).

export interface StaticRenderOptions extends RenderOptions {
  /** The stylesheet's URL (default `/styles.css`); its fonts are at `fonts/` next to it. */
  readonly stylesheetHref?: string;
  /** Put the stylesheet in the document instead of linking it (one request: screenshots, sandboxes). */
  readonly inlineCss?: boolean;
  /** The stylesheet's text (default: the built `dist/styles.css` of this package). */
  readonly css?: string;
  /** The site's origin (`https://salon.example-sites.com`), for the canonical and language alternate links. */
  readonly origin?: string;
}

let builtCss: string | undefined;

/** The built stylesheet (`pnpm --filter @bf/site-blocks build`). */
export function readStylesheet(): string {
  builtCss ??= readFileSync(new URL('../../dist/styles.css', import.meta.url), 'utf8');
  return builtCss;
}

/** Open Graph locales (`fr_FR`) of the site languages. */
const OG_LOCALES: Readonly<Record<SiteLocale, string>> = {
  fr: 'fr_FR',
  en: 'en_US',
  nl: 'nl_NL',
  es: 'es_ES',
  de: 'de_DE',
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The site's icon: its initial on its primary colour, as an SVG data URI (no request, no 404 in the console). Only a
 * Latin letter or digit is drawn, and the colours are re-checked hex: nothing from the spec reaches the URI otherwise.
 */
export function faviconHref(spec: SiteSpec): string {
  const hex = (value: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(value) ? value : fallback);
  const background = hex(spec.theme.palette.primary, '#1f2937');
  const initial = spec.brand.name
    .normalize('NFD')
    .replace(/[^A-Za-z0-9]/g, '')
    .charAt(0)
    .toUpperCase();
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='${background}'/>` +
    (initial
      ? `<text x='32' y='44' font-size='34' font-family='system-ui,sans-serif' font-weight='700' text-anchor='middle' fill='${onColor(background)}'>${initial}</text>`
      : '') +
    '</svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** JSON for a `<script>` element: `<` escaped, so no text in it can close the element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/** The business as schema.org data, from its contact facts only. */
function localBusiness(spec: SiteSpec, locale: SiteLocale, url: string | undefined) {
  const { contact, brand } = spec;
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: brand.name,
    description: pickText(spec.seo.description, locale, spec.defaultLocale),
    ...(url ? { url } : {}),
    ...(contact.phone ? { telephone: contact.phone.value } : {}),
    ...(contact.email ? { email: contact.email.value } : {}),
    ...(contact.address
      ? {
          address: {
            '@type': 'PostalAddress',
            ...(contact.address.street ? { streetAddress: contact.address.street } : {}),
            ...(contact.address.postalCode ? { postalCode: contact.address.postalCode } : {}),
            addressLocality: contact.address.locality,
            ...(contact.address.region ? { addressRegion: contact.address.region } : {}),
            addressCountry: contact.address.country,
          },
        }
      : {}),
    ...(contact.geo
      ? { geo: { '@type': 'GeoCoordinates', latitude: contact.geo.lat, longitude: contact.geo.lng } }
      : {}),
    ...(contact.socials?.length ? { sameAs: contact.socials.map((social) => social.url) } : {}),
  };
}

function head(
  spec: SiteSpec,
  page: Page,
  locale: SiteLocale,
  options: StaticRenderOptions,
  css: string,
): string {
  const hrefFor = options.hrefForPage ?? defaultPageHref;
  const absolute = (path: string) => (options.origin ? new URL(path, options.origin).href : path);
  const text = (value: Parameters<typeof pickText>[0]) =>
    escapeHtml(pickText(value, locale, spec.defaultLocale));
  const stylesheet = options.stylesheetHref ?? '/styles.css';
  // The fonts sit next to the stylesheet (a path stays a path, an absolute URL stays absolute).
  const fonts = new URL('fonts/', new URL(stylesheet, 'https://base.invalid/'));
  const fontsHref = fonts.origin === 'https://base.invalid' ? fonts.pathname : fonts.href;
  const ogImage = page.seo.ogImageAssetId
    ? spec.assets.find((asset) => asset.id === page.seo.ogImageAssetId)
    : undefined;
  const ogImageUrl = ogImage ? absolute(options.assetsResolver?.(ogImage).src ?? ogImage.url) : undefined;
  const lines = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${text(page.seo.title)}</title>`,
    `<meta name="description" content="${text(page.seo.description)}">`,
    spec.settings.noindex || options.preview ? '<meta name="robots" content="noindex, nofollow">' : '',
    `<meta name="theme-color" content="${escapeHtml(spec.theme.palette.background)}">`,
    `<link rel="icon" href="${escapeHtml(faviconHref(spec))}">`,
    options.origin
      ? `<link rel="canonical" href="${escapeHtml(absolute(hrefFor(page, locale, spec)))}">`
      : '',
    // Language alternates need absolute URLs: only with the site's origin.
    ...(options.origin && spec.locales.length > 1
      ? [
          ...spec.locales.map(
            (alternate) =>
              `<link rel="alternate" hreflang="${escapeHtml(alternate)}" href="${escapeHtml(absolute(hrefFor(page, alternate, spec)))}">`,
          ),
          `<link rel="alternate" hreflang="x-default" href="${escapeHtml(absolute(hrefFor(page, spec.defaultLocale, spec)))}">`,
        ]
      : []),
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${text(page.seo.title)}">`,
    `<meta property="og:description" content="${text(page.seo.description)}">`,
    `<meta property="og:site_name" content="${escapeHtml(spec.brand.name)}">`,
    `<meta property="og:locale" content="${OG_LOCALES[locale]}">`,
    ogImageUrl ? `<meta property="og:image" content="${escapeHtml(ogImageUrl)}">` : '',
    ...pairPreloads(spec.theme.typography.pairId).map(
      (file) =>
        `<link rel="preload" href="${escapeHtml(fontsHref + file)}" as="font" type="font/woff2" crossorigin>`,
    ),
    options.inlineCss
      ? // Inlined, the stylesheet's relative font URLs would resolve against the page: point them at the fonts.
        `<style>${css.replaceAll('url(./fonts/', `url(${fontsHref}`).replace(/<\/style/gi, '<\\/style')}</style>`
      : `<link rel="stylesheet" href="${escapeHtml(stylesheet)}">`,
    `<script type="application/ld+json">${scriptJson(localBusiness(spec, locale, options.origin ? absolute(hrefFor(page, locale, spec)) : undefined))}</script>`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * A page of a site as a complete HTML document (meta tags, language alternates, font preloads, the stylesheet
 * linked or inlined) and the stylesheet's text. Deterministic: the same input gives the same HTML.
 */
export function renderStaticPage(
  spec: SiteSpec,
  pageId: string,
  locale: SiteLocale,
  options: StaticRenderOptions = {},
): { html: string; css: string } {
  // Agents' output reaches this renderer: it renders only a spec the schema accepts.
  const site = SiteSpecSchema.parse(spec);
  const page = findPage(site, pageId);
  const lang = SiteLocaleSchema.parse(locale);
  const css = options.css ?? readStylesheet();
  const body = renderToStaticMarkup(<SitePage spec={site} page={page} locale={lang} {...options} />);
  const html = [
    '<!doctype html>',
    `<html lang="${lang}" style="background:${escapeHtml(site.theme.palette.background)}">`,
    '<head>',
    head(site, page, lang, options, css),
    '</head>',
    `<body>${body}</body>`,
    '</html>',
    '',
  ].join('\n');
  return { html, css };
}

/** The file path of a page in a static export (`index.html`, `en/carte/index.html`). */
export function staticPath(spec: SiteSpec, page: Page, locale: SiteLocale): string {
  const href = (defaultPageHref(page, locale, spec).replace(/^\//, '') || '').replace(/\/$/, '');
  // Only kebab-case segments (a locale, a slug): a path from an unvalidated spec never leaves the export folder.
  if (href && !href.split('/').every((segment) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)))
    throw new Error(`Not a page path: ${JSON.stringify(href)}`);
  return href ? `${href}/index.html` : 'index.html';
}

/** Every page of a site in every locale, as files of a static export, plus the stylesheet. */
export function renderStaticSite(
  spec: SiteSpec,
  options: StaticRenderOptions = {},
): { files: Map<string, string>; css: string } {
  const files = new Map<string, string>();
  const css = options.css ?? readStylesheet();
  for (const locale of spec.locales) {
    for (const page of spec.pages) {
      files.set(
        staticPath(spec, page, locale),
        renderStaticPage(spec, page.id, locale, { ...options, css }).html,
      );
    }
  }
  return { files, css };
}
