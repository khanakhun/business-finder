import {
  type FactRegistry,
  FactRegistrySchema,
  type Issue,
  type IssueCode,
  SiteSpecSchema,
  validateFacts,
  validateSite,
} from '@bf/site-schema';
import { limitsOf, type SitekitConfig } from './config.ts';

// `validate` (BF-042): BF-033's schema and semantic rules, the facts validator (strict facts: no facts file is an
// error) and the workspace limits, each issue with a fix hint written for an agent — the exact path, what is wrong,
// what to do.

export interface SitekitIssue extends Issue {
  /** The path as one string: `pages[0].blocks[2].props.title.fr`. */
  readonly at: string;
  readonly hint: string;
}

export const pathString = (path: readonly (string | number)[]) =>
  path.reduce<string>(
    (out, part) => (typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${part}` : String(part)),
    '',
  );

function valueAt(spec: unknown, path: readonly (string | number)[]): unknown {
  let current = spec;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

const lengthOf = (spec: unknown, path: readonly (string | number)[]) => {
  const value = valueAt(spec, path);
  return typeof value === 'string' ? value.length : undefined;
};

/** One hint per issue code: what an agent should do (BF-042 "messages written for agents"). */
const HINTS: Record<IssueCode, (issue: Issue, spec: unknown) => string> = {
  schema: (issue) =>
    `Make ${pathString(issue.path) || 'the spec'} match the SiteSpec JSON Schema (schema/site-spec.schema.json): ${issue.message}`,
  text_too_long: (issue, spec) => {
    const length = lengthOf(spec, issue.path);
    return `Shorten ${pathString(issue.path)}${length !== undefined ? ` (currently ${length} characters)` : ''}: ${issue.message}`;
  },
  locale_missing: (issue) =>
    `Add the missing locale(s) to ${pathString(issue.path)}: every text needs every site locale.`,
  locale_extra: (issue) =>
    `Remove the locale(s) the site does not have from ${pathString(issue.path)}, or add them to \`locales\`.`,
  default_locale_unknown: () => 'Set `defaultLocale` to one of `locales`.',
  duplicate_locale: () => 'List each locale once in `locales`.',
  home_missing: () => 'Add a home page: one page with `slug: ""`.',
  duplicate_slug: (issue) => `Give ${pathString(issue.path)} a slug no other page uses.`,
  duplicate_page_id: (issue) => `Give ${pathString(issue.path)} a page id no other page uses.`,
  duplicate_element_id: (issue) =>
    `Give ${pathString(issue.path)} an id unique across all blocks and assets.`,
  unknown_page: (issue) => `Point ${pathString(issue.path)} at an existing page id (see \`pages[].id\`).`,
  unknown_asset: (issue) =>
    `Point ${pathString(issue.path)} at an asset id in \`assets\` (see assets/assets.json for the images you may add).`,
  asset_kind: (issue) =>
    `Use an asset of the right kind at ${pathString(issue.path)} (a photo for images, the logo for the logo).`,
  hero_missing: (issue) => `Start ${pathString(issue.path)} with one \`hero\` block.`,
  hero_multiple: (issue) => `Keep one hero per page: change or remove ${pathString(issue.path)}.`,
  hero_not_first: (issue) => `Move the hero to the first position of ${pathString(issue.path.slice(0, 2))}.`,
  image_missing: (issue) =>
    `Set an image at ${pathString(issue.path)} or switch the block to a variant without one (e.g. hero \`centered\`).`,
  cta_missing: (issue) => `Add the call to action at ${pathString(issue.path)} (or turn \`showCta\` off).`,
  cta_unresolved: (issue) =>
    `Use a CTA kind whose channel exists in \`contact\` at ${pathString(issue.path)} (call needs contact.phone, booking needs contact.bookingUrl…).`,
  text_length: (issue, spec) => {
    const length = lengthOf(spec, issue.path);
    return `Adjust the length of ${pathString(issue.path)}${length !== undefined ? ` (currently ${length})` : ''}: ${issue.message}`;
  },
  contrast_low: (issue) =>
    `Pick a colour with more contrast at ${pathString(issue.path)} (text ≥ 4.5:1, accents ≥ 3:1 on the background).`,
  external_url: (issue) =>
    `Remove the external link at ${pathString(issue.path)}: link to the site's own pages, the business's domain or a known booking provider.`,
  asset_host: (issue) =>
    `Use an image from assets/assets.json at ${pathString(issue.path)} (our storage hosts only).`,
  asset_hotlink: (issue) =>
    `Serve ${pathString(issue.path)} from our storage, or mark it \`hosting: "hotlink"\` only for a stock CDN that requires it.`,
  asset_preview_only: (issue) =>
    `Image ${pathString(issue.path)} is preview-only (ownership not confirmed): fine for a preview; replace it before going live.`,
  social_host: (issue) =>
    `Use the network's own profile URL at ${pathString(issue.path)} (e.g. https://www.instagram.com/<handle>).`,
  no_contact_channel: () =>
    'Add a contact channel from facts.json (phone, e-mail, WhatsApp) or enable `settings.contactForm`.',
  block_requirement: (issue) =>
    `Give ${pathString(issue.path)} what it needs (${issue.message}), or remove the block.`,
  rich_text: (issue) =>
    `Use the allowed markdown subset at ${pathString(issue.path)}: paragraphs, **bold**, *italic*, lists and [label](page:<id>) links.`,
  html: (issue) => `Remove the HTML at ${pathString(issue.path)}: write plain text.`,
  preview_settings: () => 'A preview needs `settings.noindex: true` and `settings.previewBanner: true`.',
  fact_unknown: (issue) =>
    `Use a fact id from facts.json at ${pathString(issue.path)} (\`sitekit facts\` lists them), or remove the reference.`,
  fact_kind: (issue) => `Reference a fact of the right kind at ${pathString(issue.path)}: ${issue.message}`,
  fact_mismatch: (issue) =>
    `Write the value exactly as the fact states it at ${pathString(issue.path)} (\`sitekit facts\` shows it).`,
  unsupported_literal: (issue) =>
    `Remove or replace the number, phone, e-mail, price or year at ${pathString(issue.path)}: only facts from facts.json may be stated.`,
};

const withHint = (issue: Issue, spec: unknown): SitekitIssue => ({
  ...issue,
  at: pathString(issue.path),
  hint: HINTS[issue.code](issue, spec),
});

export interface ValidateInput {
  readonly facts?: FactRegistry;
  readonly strictFacts?: boolean;
  readonly config: SitekitConfig;
  /** Bytes of `site.json` as read (limits). */
  readonly bytes?: number;
}

export function validate(spec: unknown, input: ValidateInput): SitekitIssue[] {
  const { config } = input;
  const strict = input.strictFacts ?? config.strictFacts;
  const issues: SitekitIssue[] = [];
  const limits = limitsOf(config);
  if (input.bytes !== undefined && input.bytes > limits.specBytes)
    issues.push({
      path: [],
      code: 'text_length',
      severity: 'error',
      message: `site.json is ${input.bytes} bytes; the limit is ${limits.specBytes}.`,
      at: '',
      hint: `Make site.json smaller than ${limits.specBytes} bytes (fewer blocks, shorter texts).`,
    });
  const semantic = validateSite(spec, {
    assetHosts: config.assetHosts,
    hotlinkHosts: config.hotlinkHosts,
    ownDomains: config.ownDomains,
    mode: 'preview',
  });
  issues.push(...semantic.map((issue) => withHint(issue, spec)));
  const parsed = SiteSpecSchema.safeParse(spec);
  if (!parsed.success) return issues;
  const site = parsed.data;
  if (site.pages.length > limits.pages)
    issues.push({
      path: ['pages'],
      code: 'block_requirement',
      severity: 'error',
      message: `The site has ${site.pages.length} pages; the limit is ${limits.pages}.`,
      at: 'pages',
      hint: `Remove or merge pages until there are at most ${limits.pages}.`,
    });
  site.pages.forEach((page, index) => {
    if (page.blocks.length > limits.blocksPerPage)
      issues.push({
        path: ['pages', index, 'blocks'],
        code: 'block_requirement',
        severity: 'error',
        message: `Page ${page.id} has ${page.blocks.length} blocks; the limit is ${limits.blocksPerPage}.`,
        at: `pages[${index}].blocks`,
        hint: `Remove blocks from page ${page.id} until there are at most ${limits.blocksPerPage}.`,
      });
  });
  if (input.facts) issues.push(...validateFacts(site, input.facts).map((issue) => withHint(issue, spec)));
  else if (strict)
    issues.push({
      path: [],
      code: 'fact_unknown',
      severity: 'error',
      message: 'Strict facts: facts.json is missing, so no fact can be checked.',
      at: '',
      hint: 'Run in a workspace that has facts.json (the generation workspace always does).',
    });
  return issues;
}

/** facts.json as BF-033's registry (extra keys — provenance, evidence — are kept out). */
export function parseFacts(value: unknown): FactRegistry {
  return FactRegistrySchema.parse(value);
}
