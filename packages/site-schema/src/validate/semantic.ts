import type { z } from 'zod';
import type { BlockOf, BlockType } from '../spec/blocks/index.ts';
import { LIMITS, type LimitKey } from '../spec/limits.ts';
import { SITE_LOCALES, type SiteLocale } from '../spec/localized.ts';
import { type SiteSpec, SiteSpecSchema } from '../spec/site.ts';
import type { Palette } from '../spec/theme.ts';
import { contrastRatio, suggestColor } from './contrast.ts';
import { EMAIL_AT } from './email.ts';
import { carriesUrl, hasWebAddress, hostAllowed, isSocialProfile, KNOWN_BOOKING_HOSTS } from './hosts.ts';
import { error, type Issue, warning } from './issues.ts';
import { HTML_TAG, parseRichText, withoutPageLinks } from './rich-text.ts';
import { isCta, isLocalized, type Path, walk } from './walk.ts';

// The semantic validator (BF-033): what the schema cannot say. Each rule is a small function over the parsed spec
// (Specification); issues name the path and an actionable fix. Errors block publishing; warnings are advice.
//
// Two phases: schema problems first (the rules need a spec that parses); once they are fixed, the semantic issues.

export interface ValidateOptions {
  /** Our storage/CDN hosts: the only hosts an asset may be served from (matched exactly). */
  readonly assetHosts: readonly string[];
  /** The business's own domains (its existing website): `url` actions and the booking page may point there. */
  readonly ownDomains?: readonly string[];
  /** Booking providers a booking page may be on (defaults to the known ones). */
  readonly bookingHosts?: readonly string[];
  /** `preview` (the default): the site must keep `noindex` and the preview banner on. */
  readonly mode?: 'preview' | 'published';
}

type Rule = (spec: SiteSpec, options: ValidateOptions) => Issue[];

/** Parses with the schema; its problems become issues (an over-long text gets its own code). */
export function parseSite(input: unknown): { spec: SiteSpec | null; issues: Issue[] } {
  const parsed = SiteSpecSchema.safeParse(input);
  if (parsed.success) return { spec: parsed.data, issues: [] };
  return { spec: null, issues: parsed.error.issues.map(schemaIssue) };
}

function schemaIssue(issue: z.core.$ZodIssue): Issue {
  const path = issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part));
  if (issue.code === 'too_big' && issue.origin === 'string') {
    return error(path, 'text_too_long', `Shorten this to at most ${String(issue.maximum)} characters.`);
  }
  return error(path, 'schema', issue.message);
}

const previewRule: Rule = (spec, options) => {
  if ((options.mode ?? 'preview') !== 'preview') return [];
  const issues: Issue[] = [];
  if (!spec.settings.noindex)
    issues.push(
      error(['settings', 'noindex'], 'preview_settings', 'Set noindex to true: a preview is never indexed.'),
    );
  if (!spec.settings.previewBanner)
    issues.push(
      error(
        ['settings', 'previewBanner'],
        'preview_settings',
        'Set previewBanner to true: a preview says it is one.',
      ),
    );
  return issues;
};

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
          warning([...path, locale], 'locale_extra', `Remove the ${locale} text: it is not a site locale.`),
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
  const slugs = new Set<string>();
  const pageIds = new Set<string>();
  for (const [i, page] of spec.pages.entries()) {
    if (slugs.has(page.slug))
      issues.push(
        error(['pages', i, 'slug'], 'duplicate_slug', `Use another slug: "${page.slug}" is taken.`),
      );
    slugs.add(page.slug);
    if (pageIds.has(page.id))
      issues.push(
        error(['pages', i, 'id'], 'duplicate_page_id', `Use another page id: "${page.id}" is taken.`),
      );
    pageIds.add(page.id);
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

/** Block variants that show an image (Specification table): the image field they need. */
type ImageVariants = { readonly [T in BlockType]?: Partial<Readonly<Record<BlockOf<T>['variant'], string>>> };
const IMAGE_VARIANTS: ImageVariants = {
  hero: { split: 'imageAssetId', image_full: 'imageAssetId' },
  cta_banner: { image: 'imageAssetId' },
  about: { split: 'imageAssetId', story: 'imageAssetId' },
};

const heroRule: Rule = (spec) => {
  const issues: Issue[] = [];
  for (const [i, page] of spec.pages.entries()) {
    const heroes = page.blocks.flatMap((block, j) => (block.type === 'hero' ? [j] : []));
    if (heroes.length === 0)
      issues.push(
        error(
          ['pages', i, 'blocks'],
          'hero_missing',
          'Start the page with a hero block (its one main heading).',
        ),
      );
    for (const j of heroes.slice(1)) {
      issues.push(
        error(
          ['pages', i, 'blocks', j],
          'hero_multiple',
          'Keep one hero per page: change this one into another block.',
        ),
      );
    }
    if (heroes[0] !== undefined && heroes[0] !== 0)
      issues.push(
        warning(['pages', i, 'blocks', heroes[0]], 'hero_not_first', 'Move the hero to the top of the page.'),
      );
    for (const [j, block] of page.blocks.entries()) {
      const field = (IMAGE_VARIANTS[block.type] as Readonly<Record<string, string>> | undefined)?.[
        block.variant
      ];
      if (field && !(block.props as Record<string, unknown>)[field]) {
        issues.push(
          error(
            ['pages', i, 'blocks', j, 'props', field],
            'image_missing',
            `Give the ${block.variant} ${block.type} an image, or pick a variant without one.`,
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
  // A `url` action goes to the business's own domain only: a booking provider is reached through `booking` (the
  // fact-backed booking page), never a page anyone can create there.
  const allowedUrlHosts = options.ownDomains ?? [];
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
        if (!value.url || !hostAllowed(value.url, allowedUrlHosts) || carriesUrl(value.url))
          issues.push(
            error(
              [...path, 'url'],
              'external_url',
              "Link only to the business's own domain (use a booking action for its booking page).",
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

/** Strings that are not text: URLs (checked against their allowlists), the e-mail address, ids and references. */
const NOT_TEXT_KEYS = new Set([
  'url',
  'id',
  'pageId',
  'factId',
  'type',
  'variant',
  'kind',
  'network',
  'country',
  'currency',
]);
const NOT_TEXT_PARENTS = new Set([
  'bookingUrl',
  'email',
  'phone',
  'whatsapp',
  'factIds',
  'assetIds',
  'palette',
  'typography',
]);
const LOCALES: ReadonlySet<string> = new Set(SITE_LOCALES);
const skipped = (path: Path) => {
  const key = String(path.at(-1));
  // A locale's text is scanned with its localized field.
  if (LOCALES.has(key)) return true;
  return NOT_TEXT_KEYS.has(key) || key.endsWith('AssetId') || NOT_TEXT_PARENTS.has(String(path.at(-2)));
};
/** An e-mail address, also spelled out (anchored and bounded: linear on long words). */
const EMAIL = new RegExp(
  String.raw`(?<![\w.+-])([\w.+-]{1,64})${EMAIL_AT}[\w-]{1,63}(?:\.[\w-]{1,63}){1,10}`,
  'gi',
);
/** A URL scheme (`http:`, `javascript:`…): an e-mail after one in the same word is a URL's user part. */
const URL_SCHEME = /(?:^|[^\w+.-])(?:https?|ftps?|sftp|wss?|file|javascript|data|intent|ssh|smb):/i;

/**
 * An e-mail that is really a web address: a `www.` local part, `/` or `\\` just before it, or a URL scheme in the
 * word before it (`http:evil.com@a.bc`, `http:mailto:evil.com@a.bc`). A label (`Email:`, `Mél.:`) is not one.
 */
function dressedEmail(local: string, before: string): boolean {
  if (/^www\./i.test(local) || /[/\\]$/.test(before)) return true;
  const word = /\S*$/.exec(before.slice(-60))?.[0] ?? '';
  return URL_SCHEME.test(word);
}

const urlsRule: Rule = (spec, options) => {
  const issues: Issue[] = [];
  for (const [i, asset] of spec.assets.entries()) {
    if (!hostAllowed(asset.url, options.assetHosts, { subdomains: false }))
      issues.push(
        error(['assets', i, 'url'], 'asset_host', 'Upload the image to our storage and use that URL.'),
      );
  }
  const booking = spec.contact.bookingUrl;
  if (
    booking &&
    (!hostAllowed(booking.value, [
      ...(options.ownDomains ?? []),
      ...(options.bookingHosts ?? KNOWN_BOOKING_HOSTS),
    ]) ||
      carriesUrl(booking.value))
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
    if (!isSocialProfile(social.network, social.url))
      issues.push(
        error(
          ['contact', 'socials', i, 'url'],
          'social_host',
          `Use the business's own ${social.network} profile URL (no redirect, no query).`,
        ),
      );
  }
  // Text never carries a web address or HTML: links are actions; rich text links to the site's pages only.
  const isRichText = (path: Path) => {
    const [pages, i, blocks, j, props, body] = path;
    return (
      pages === 'pages' &&
      blocks === 'blocks' &&
      props === 'props' &&
      body === 'body' &&
      spec.pages[Number(i)]?.blocks[Number(j)]?.type === 'rich_text'
    );
  };
  const scan = (text: string, path: Path) => {
    // Rich text: its links and HTML are the rich-text rule's; a web address in its words is still refused.
    const rich = isRichText(path);
    // E-mails are the facts validator's; one dressed around a web address (`www.evil.com@a.bc`, `//evil.com@a.bc`)
    // is not: folded first, then judged by `www.` or what is just before it (`/`, `\\`, a URL scheme).
    const words = (rich ? withoutPageLinks(text) : text)
      .normalize('NFKC')
      .replace(EMAIL, (address, local: string, offset: number, whole: string) =>
        dressedEmail(local, whole.slice(0, offset)) ? address : '',
      );
    if (hasWebAddress(words)) {
      issues.push(
        error(
          path,
          'external_url',
          'Remove the web address from the text (use an action instead); if it is not one, put a space after the full stop.',
        ),
      );
    }
    if (!rich && HTML_TAG.test(text)) issues.push(error(path, 'html', 'Remove the HTML: texts are plain.'));
  };

  for (const { value, path } of walk(spec)) {
    if (isLocalized(value)) {
      for (const [locale, text] of Object.entries(value)) scan(text ?? '', [...path, locale]);
    } else if (typeof value === 'string' && !skipped(path)) {
      scan(value, path);
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
        const parsed = parseRichText(text ?? '');
        for (const problem of parsed.problems)
          issues.push(error(path, 'rich_text', `Fix the text: ${problem}.`));
        for (const id of parsed.pageIds) {
          if (!pages.has(id))
            issues.push(error(path, 'unknown_page', `Link to an existing page: there is no page "${id}".`));
        }
      }
    }
  }
  return issues;
};

/** Texts with a recommended length (a warning outside it). */
const targetsRule: Rule = (spec) => {
  const issues: Issue[] = [];
  const check = (text: Partial<Record<string, string>>, path: Path, limit: LimitKey) => {
    const target = (LIMITS[limit] as { target?: readonly [number, number] }).target;
    if (!target) return;
    for (const locale of spec.locales) {
      const value = text[locale];
      if (value === undefined) continue;
      if (value.length < target[0] || value.length > target[1]) {
        issues.push(
          warning(
            [...path, locale],
            'text_length',
            `Aim for ${target[0]}–${target[1]} characters (now ${value.length}).`,
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
};

/**
 * WCAG AA: text and muted text 4.5:1 on background and surface; primary, accent and secondary 3:1 on the background
 * (large text, UI). Button labels on primary use `onColor` (black or white always reaches 4.5:1). One suggestion per
 * colour, passing every pair it is in.
 */
const PAIRS: readonly (readonly [keyof Palette, readonly (keyof Palette)[], number])[] = [
  ['text', ['background', 'surface'], 4.5],
  ['mutedText', ['background', 'surface'], 4.5],
  ['primary', ['background'], 3],
  ['accent', ['background'], 3],
  ['secondary', ['background'], 3],
];

/** The button label colour on `primary`: black or white, whichever reads better. */
export function onColor(background: string): '#000000' | '#ffffff' {
  return contrastRatio('#000000', background) >= contrastRatio('#ffffff', background) ? '#000000' : '#ffffff';
}

const contrastRule: Rule = (spec) => {
  const { palette } = spec.theme;
  const issues: Issue[] = [];
  for (const [fg, backgrounds, ratio] of PAIRS) {
    const color = palette[fg];
    if (!color) continue;
    const failing = backgrounds.filter((bg) => contrastRatio(color, palette[bg] as string) < ratio);
    if (failing.length === 0) continue;
    const against = backgrounds.map((bg) => palette[bg] as string);
    const fix = suggestColor(color, against, ratio);
    const ratios = failing
      .map((bg) => `${contrastRatio(color, palette[bg] as string).toFixed(2)}:1 on ${bg}`)
      .join(', ');
    issues.push(
      error(
        ['theme', 'palette', fg],
        'contrast_low',
        `${fg} has ${ratios}, below ${ratio}:1${fix ? `; try ${fix}` : '; change the background'}.`,
      ),
    );
  }
  return issues;
};

const RULES: readonly Rule[] = [
  previewRule,
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

/** Every issue of a spec: the schema's first (the rules need a spec that parses), then every rule's. */
export function validateSite(input: unknown, options: ValidateOptions): Issue[] {
  const { spec, issues } = parseSite(input);
  if (!spec) return issues;
  return RULES.flatMap((rule) => rule(spec, options));
}
