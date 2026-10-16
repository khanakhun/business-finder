import type { z } from 'zod';
import { LIMITS, type LimitKey } from '../spec/limits.ts';
import type { SiteLocale } from '../spec/localized.ts';
import { type SiteSpec, SiteSpecSchema } from '../spec/site.ts';
import { contrastRatio, suggestColor } from './contrast.ts';
import { hostAllowed, KNOWN_BOOKING_HOSTS, SOCIAL_HOSTS } from './hosts.ts';
import { error, type Issue, warning } from './issues.ts';
import { isCta, isLocalized, type Path, walk } from './walk.ts';

// The semantic validator (BF-033): what the schema cannot say. Each rule is a small function over the parsed spec
// (Specification); issues name the path and an actionable fix. Errors block publishing; warnings are advice.

export interface ValidateOptions {
  /** Our storage/CDN hosts: the only hosts an asset may be served from. */
  readonly assetHosts: readonly string[];
  /** The business's own domains (its existing website): `url` actions and the booking page may point there. */
  readonly ownDomains?: readonly string[];
  /** Booking providers a booking page may be on (defaults to the known ones). */
  readonly bookingHosts?: readonly string[];
}

type Rule = (spec: SiteSpec, options: ValidateOptions) => Issue[];

const pathKey = (path: Path) => path.join('.');

/** Parses with the schema; its problems become issues (an over-long text gets its own code). */
export function parseSite(input: unknown): { spec: SiteSpec | null; issues: Issue[] } {
  const parsed = SiteSpecSchema.safeParse(input);
  if (parsed.success) return { spec: parsed.data, issues: [] };
  return { spec: null, issues: parsed.error.issues.map(schemaIssue) };
}

function schemaIssue(issue: z.core.$ZodIssue): Issue {
  const path = issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part));
  if (issue.code === 'too_big' && issue.origin === 'string') {
    return error(path, 'text_too_long', `Shorten this text to at most ${String(issue.maximum)} characters.`);
  }
  return error(path, 'schema', issue.message);
}

const localesRule: Rule = (spec) => {
  const issues: Issue[] = [];
  if (!spec.locales.includes(spec.defaultLocale)) {
    issues.push(
      error(
        ['defaultLocale'],
        'default_locale_unknown',
        `Set defaultLocale to one of ${spec.locales.join(', ')}.`,
      ),
    );
  }
  if (new Set(spec.locales).size !== spec.locales.length) {
    issues.push(error(['locales'], 'duplicate_locale', 'List each locale once.'));
  }
  for (const { value, path } of walk(spec)) {
    if (!isLocalized(value)) continue;
    for (const locale of spec.locales) {
      if (value[locale] === undefined) {
        issues.push(
          error(
            [...path, locale],
            'locale_missing',
            `Add the ${locale} text (every site locale is required).`,
          ),
        );
      }
    }
    for (const locale of Object.keys(value)) {
      if (!spec.locales.includes(locale as SiteLocale)) {
        issues.push(
          warning([...path, locale], 'locale_missing', `Remove the ${locale} text: it is not a site locale.`),
        );
      }
    }
  }
  return issues;
};

const structureRule: Rule = (spec) => {
  const issues: Issue[] = [];
  if (!spec.pages.some((page) => page.slug === '')) {
    issues.push(error(['pages'], 'home_missing', 'Add a home page (slug "").'));
  }
  const slugs = new Map<string, number>();
  const pageIds = new Map<string, number>();
  for (const [i, page] of spec.pages.entries()) {
    if (slugs.has(page.slug))
      issues.push(
        error(['pages', i, 'slug'], 'duplicate_slug', `Use another slug: "${page.slug}" is taken.`),
      );
    slugs.set(page.slug, i);
    if (pageIds.has(page.id))
      issues.push(
        error(['pages', i, 'id'], 'duplicate_page_id', `Use another page id: "${page.id}" is taken.`),
      );
    pageIds.set(page.id, i);
  }
  const ids = new Set<string>();
  const unique = (id: string, path: Path) => {
    if (ids.has(id))
      issues.push(error(path, 'duplicate_element_id', `Use another id: "${id}" is used twice.`));
    ids.add(id);
  };
  for (const [i, asset] of spec.assets.entries()) unique(asset.id, ['assets', i, 'id']);
  for (const [i, page] of spec.pages.entries()) {
    for (const [j, block] of page.blocks.entries()) unique(block.id, ['pages', i, 'blocks', j, 'id']);
  }
  return issues;
};

const heroRule: Rule = (spec) => {
  const issues: Issue[] = [];
  for (const [i, page] of spec.pages.entries()) {
    const heroes = page.blocks.flatMap((block, j) => (block.type === 'hero' ? [{ block, j }] : []));
    if (heroes.length === 0)
      issues.push(
        error(
          ['pages', i, 'blocks'],
          'hero_missing',
          'Start the page with a hero block (its one main heading).',
        ),
      );
    for (const extra of heroes.slice(1)) {
      issues.push(
        error(
          ['pages', i, 'blocks', extra.j],
          'hero_multiple',
          'Keep one hero per page: change this one into another block.',
        ),
      );
    }
    const first = heroes[0];
    if (first && first.j !== 0)
      issues.push(
        warning(['pages', i, 'blocks', first.j], 'hero_not_first', 'Move the hero to the top of the page.'),
      );
    for (const { block, j } of heroes) {
      if ((block.variant === 'split' || block.variant === 'image_full') && !block.props.imageAssetId) {
        issues.push(
          error(
            ['pages', i, 'blocks', j, 'props', 'imageAssetId'],
            'hero_image_missing',
            `Give the ${block.variant} hero an image, or use the centered variant.`,
          ),
        );
      }
    }
  }
  return issues;
};

const referencesRule: Rule = (spec) => {
  const issues: Issue[] = [];
  const pages = new Set(spec.pages.map((page) => page.id));
  const assets = new Map(spec.assets.map((asset) => [asset.id, asset]));
  for (const [i, item] of spec.navigation.items.entries()) {
    if (!pages.has(item.pageId))
      issues.push(
        error(
          ['navigation', 'items', i, 'pageId'],
          'unknown_page',
          `Point the menu item to an existing page (no page "${item.pageId}").`,
        ),
      );
  }
  const checkAsset = (id: string, path: Path, kinds?: readonly string[]) => {
    const asset = assets.get(id);
    if (!asset)
      issues.push(error(path, 'unknown_asset', `Add asset "${id}" to assets or pick an existing one.`));
    else if (kinds && !kinds.includes(asset.kind))
      issues.push(
        error(path, 'asset_kind', `Use ${kinds.join(' or ')} asset here ("${id}" is a ${asset.kind}).`),
      );
  };
  for (const { value, path, key } of walk(spec)) {
    if (typeof value === 'string' && typeof key === 'string') {
      if (key === 'logoAssetId') checkAsset(value, path, ['logo']);
      else if (key.endsWith('AssetId')) checkAsset(value, path, ['image', 'logo']);
    }
    if (key === 'assetIds' && Array.isArray(value)) {
      for (const [n, id] of value.entries())
        if (typeof id === 'string') checkAsset(id, [...path, n], ['image']);
    }
  }
  return issues;
};

const ctaRule: Rule = (spec, options) => {
  const issues: Issue[] = [];
  const pages = new Set(spec.pages.map((page) => page.id));
  const { contact } = spec;
  const allowedUrlHosts = [...(options.ownDomains ?? []), ...(options.bookingHosts ?? KNOWN_BOOKING_HOSTS)];
  for (const { value, path } of walk(spec)) {
    if (!isCta(value)) continue;
    const missing = (fact: string) =>
      issues.push(error(path, 'cta_unresolved', `Add ${fact} to contact, or change the action.`));
    switch (value.kind) {
      case 'call':
        if (!contact.phone) missing('a phone number');
        break;
      case 'email':
        if (!contact.email) missing('an e-mail address');
        break;
      case 'whatsapp':
        if (!contact.whatsapp) missing('a WhatsApp number');
        break;
      case 'booking':
        if (!contact.bookingUrl) missing('the booking page (bookingUrl)');
        break;
      case 'directions':
        if (!contact.address && !contact.geo) missing('an address or coordinates');
        break;
      case 'page':
        if (!value.pageId || !pages.has(value.pageId))
          issues.push(error([...path, 'pageId'], 'unknown_page', 'Point the action to an existing page id.'));
        break;
      case 'url':
        if (!value.url)
          issues.push(
            error([...path, 'url'], 'cta_unresolved', 'Give the url action a URL, or use another kind.'),
          );
        else if (!hostAllowed(value.url, allowedUrlHosts))
          issues.push(
            error(
              [...path, 'url'],
              'external_url',
              "Link only to the business's own domain or its booking provider.",
            ),
          );
        break;
    }
  }
  const { header, footer } = spec.layout;
  if (header.showCta && !header.cta)
    issues.push(
      error(
        ['layout', 'header', 'cta'],
        'cta_missing',
        'Give the header a call to action, or set showCta to false.',
      ),
    );
  if (footer.showSocials && !contact.socials?.length)
    issues.push(
      warning(
        ['layout', 'footer', 'showSocials'],
        'block_requirement',
        'Set showSocials to false: the business has no social profiles.',
      ),
    );
  if (footer.showHours && !contact.hours)
    issues.push(
      warning(
        ['layout', 'footer', 'showHours'],
        'block_requirement',
        'Set showHours to false: the opening hours are unknown.',
      ),
    );
  return issues;
};

const urlsRule: Rule = (spec, options) => {
  const issues: Issue[] = [];
  for (const [i, asset] of spec.assets.entries()) {
    if (!hostAllowed(asset.url, options.assetHosts))
      issues.push(
        error(['assets', i, 'url'], 'asset_host', 'Upload the image to our storage and use that URL.'),
      );
  }
  const booking = spec.contact.bookingUrl;
  if (
    booking &&
    !hostAllowed(booking.value, [
      ...(options.ownDomains ?? []),
      ...(options.bookingHosts ?? KNOWN_BOOKING_HOSTS),
    ])
  ) {
    issues.push(
      error(
        ['contact', 'bookingUrl', 'value'],
        'external_url',
        "Use the business's booking page on its own domain or a known booking provider.",
      ),
    );
  }
  for (const [i, social] of (spec.contact.socials ?? []).entries()) {
    if (!hostAllowed(social.url, SOCIAL_HOSTS[social.network] ?? []))
      issues.push(
        error(
          ['contact', 'socials', i, 'url'],
          'social_host',
          `Use the business's ${social.network} profile URL.`,
        ),
      );
  }
  // Free text never carries links (rich text links to own pages only, checked by the rich-text rule).
  for (const { value, path } of walk(spec.pages)) {
    if (!isLocalized(value)) continue;
    for (const [locale, text] of Object.entries(value)) {
      if (/https?:\/\/|\bwww\.[a-z0-9-]+\./i.test((text ?? '').replace(/\]\(page:[^)]*\)/g, ''))) {
        issues.push(
          error(
            ['pages', ...path, locale],
            'external_url',
            'Remove the web address from the text; use an action instead.',
          ),
        );
      }
    }
  }
  return issues;
};

const contactRule: Rule = (spec) => {
  const { contact, settings } = spec;
  const issues: Issue[] = [];
  if (!contact.phone && !contact.email && !contact.whatsapp && !settings.contactForm.enabled) {
    issues.push(
      error(
        ['contact'],
        'no_contact_channel',
        'Add a phone, e-mail or WhatsApp from the facts, or enable the contact form.',
      ),
    );
  }
  for (const [i, page] of spec.pages.entries()) {
    for (const [j, block] of page.blocks.entries()) {
      const at = (...rest: (string | number)[]) => ['pages', i, 'blocks', j, ...rest];
      const need = (ok: boolean, message: string, ...rest: (string | number)[]) => {
        if (!ok) issues.push(error(at(...rest), 'block_requirement', message));
      };
      switch (block.type) {
        case 'booking':
          need(
            !!contact.bookingUrl,
            'Remove the booking block or add the booking page (contact.bookingUrl).',
          );
          break;
        case 'hours':
          need(!!contact.hours, 'Remove the hours block: the opening hours are unknown.');
          break;
        case 'location':
          need(!!contact.address || !!contact.geo, 'Remove the location block or add an address.');
          break;
        case 'social_links':
          need(
            !!contact.socials?.length,
            'Remove the social links block: the business has no social profiles.',
          );
          break;
        case 'contact': {
          const { channels, showForm } = block.props;
          if (showForm)
            need(
              settings.contactForm.enabled,
              'Enable settings.contactForm or hide the form.',
              'props',
              'showForm',
            );
          if (channels.phone)
            need(
              !!contact.phone,
              'Hide the phone channel: there is no phone number.',
              'props',
              'channels',
              'phone',
            );
          if (channels.email)
            need(
              !!contact.email,
              'Hide the e-mail channel: there is no e-mail address.',
              'props',
              'channels',
              'email',
            );
          if (channels.whatsapp)
            need(
              !!contact.whatsapp,
              'Hide the WhatsApp channel: there is no WhatsApp number.',
              'props',
              'channels',
              'whatsapp',
            );
          need(
            showForm || channels.phone || channels.email || channels.whatsapp,
            'Show at least one channel or the form.',
            'props',
          );
          break;
        }
        default:
          break;
      }
    }
  }
  return issues;
};

const richTextRule: Rule = (spec) => {
  const issues: Issue[] = [];
  const pages = new Set(spec.pages.map((page) => page.id));
  for (const [i, page] of spec.pages.entries()) {
    for (const [j, block] of page.blocks.entries()) {
      if (block.type !== 'rich_text') continue;
      for (const [locale, text] of Object.entries(block.props.body)) {
        const path = ['pages', i, 'blocks', j, 'props', 'body', locale];
        if (/<\/?[a-z][\s\S]*?>/i.test(text ?? ''))
          issues.push(error(path, 'rich_text', 'Remove the HTML: use the markdown subset only.'));
        for (const match of (text ?? '').matchAll(/\]\(([^)]*)\)/g)) {
          const target = match[1] ?? '';
          const id = target.startsWith('page:') ? target.slice(5) : null;
          if (!id)
            issues.push(
              error(path, 'rich_text', `Link only to the site's pages as (page:<id>), not "${target}".`),
            );
          else if (!pages.has(id))
            issues.push(error(path, 'unknown_page', `Link to an existing page: there is no page "${id}".`));
        }
      }
    }
  }
  return issues;
};

/** Texts with a recommended length (a warning outside it). */
function targetsRule(spec: SiteSpec): Issue[] {
  const issues: Issue[] = [];
  const check = (text: Partial<Record<string, string>>, path: Path, limit: LimitKey) => {
    const target = (LIMITS[limit] as { target?: readonly [number, number] }).target;
    if (!target) return;
    for (const locale of spec.locales) {
      const value = text[locale];
      if (value === undefined) continue;
      const length = value.length;
      if (length < target[0] || length > target[1]) {
        issues.push(
          warning(
            [...path, locale],
            'text_length',
            `Aim for ${target[0]}–${target[1]} characters (now ${length}).`,
          ),
        );
      }
    }
  };
  check(spec.seo.title, ['seo', 'title'], 'siteTitle');
  check(spec.seo.description, ['seo', 'description'], 'siteDescription');
  for (const [i, page] of spec.pages.entries()) {
    check(page.seo.title, ['pages', i, 'seo', 'title'], 'seoTitle');
    check(page.seo.description, ['pages', i, 'seo', 'description'], 'seoDescription');
    for (const [j, block] of page.blocks.entries()) {
      if (block.type !== 'hero') continue;
      check(block.props.title, ['pages', i, 'blocks', j, 'props', 'title'], 'heroTitle');
      if (block.props.subtitle)
        check(block.props.subtitle, ['pages', i, 'blocks', j, 'props', 'subtitle'], 'heroSubtitle');
    }
  }
  for (const [i, asset] of spec.assets.entries()) check(asset.alt, ['assets', i, 'alt'], 'alt');
  return issues;
}

/** Text 4.5:1 on background and surface, muted text 4.5:1 on background, primary and accent 3:1 (large text, UI). */
const PAIRS = [
  ['text', 'background', 4.5],
  ['text', 'surface', 4.5],
  ['mutedText', 'background', 4.5],
  ['primary', 'background', 3],
  ['accent', 'background', 3],
] as const;

const contrastRule: Rule = (spec) => {
  const { palette } = spec.theme;
  return PAIRS.flatMap(([fg, bg, ratio]) => {
    const actual = contrastRatio(palette[fg], palette[bg]);
    if (actual >= ratio) return [];
    const fix = suggestColor(palette[fg], palette[bg], ratio);
    return [
      error(
        ['theme', 'palette', fg],
        'contrast_low',
        `${fg} on ${bg} has ${actual.toFixed(2)}:1, below ${ratio}:1${fix ? `; try ${fix}` : '; change the background'}.`,
      ),
    ];
  });
};

const RULES: readonly Rule[] = [
  localesRule,
  structureRule,
  heroRule,
  referencesRule,
  ctaRule,
  urlsRule,
  contactRule,
  richTextRule,
  targetsRule,
  contrastRule,
];

/** Every issue of a spec (schema first: semantic rules run only on a spec that parses). */
export function validateSite(input: unknown, options: ValidateOptions): Issue[] {
  const { spec, issues } = parseSite(input);
  if (!spec) return issues;
  const seen = new Set<string>();
  return RULES.flatMap((rule) => rule(spec, options)).filter((issue) => {
    const key = `${issue.code}:${pathKey(issue.path)}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
