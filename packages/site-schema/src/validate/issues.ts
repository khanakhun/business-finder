// Validation issues (BF-033): what is wrong, where, and how to fix it — written for the agent or person editing.

export const ISSUE_CODES = [
  // Shape (from the schema)
  'schema',
  'text_too_long',
  // Languages
  'locale_missing',
  'locale_extra',
  'default_locale_unknown',
  'duplicate_locale',
  // Structure and references
  'home_missing',
  'duplicate_slug',
  'duplicate_page_id',
  'duplicate_element_id',
  'unknown_page',
  'unknown_asset',
  'asset_kind',
  'hero_missing',
  'hero_multiple',
  'hero_not_first',
  'image_missing',
  'cta_missing',
  'cta_unresolved',
  // Content rules
  'text_length',
  'contrast_low',
  'external_url',
  'asset_host',
  'social_host',
  'no_contact_channel',
  'block_requirement',
  'rich_text',
  'html',
  'preview_settings',
  // Facts (validateFacts)
  'fact_unknown',
  'fact_kind',
  'fact_mismatch',
  'unsupported_literal',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface Issue {
  /** Path in the spec, e.g. `['pages', 0, 'blocks', 2, 'props', 'title', 'fr']`. */
  readonly path: readonly (string | number)[];
  readonly code: IssueCode;
  readonly severity: 'error' | 'warning';
  /** What to change, in one sentence. */
  readonly message: string;
}

export const error = (path: Issue['path'], code: IssueCode, message: string): Issue => ({
  path,
  code,
  severity: 'error',
  message,
});

export const warning = (path: Issue['path'], code: IssueCode, message: string): Issue => ({
  path,
  code,
  severity: 'warning',
  message,
});

export const hasErrors = (issues: readonly Issue[]) => issues.some((issue) => issue.severity === 'error');
