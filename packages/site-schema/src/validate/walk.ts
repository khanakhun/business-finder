import { CTA_KINDS } from '../spec/cta.ts';
import { SITE_LOCALES } from '../spec/localized.ts';

// Walks a spec (BF-033): every value with its path, so rules can find localized texts, actions and asset references
// wherever blocks put them.

export type Path = readonly (string | number)[];

export function* walk(
  value: unknown,
  path: Path = [],
): Generator<{ value: unknown; path: Path; key: string | number | undefined }> {
  yield { value, path, key: path.at(-1) };
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) yield* walk(item, [...path, i]);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) yield* walk(item, [...path, key]);
  }
}

const LOCALES = new Set<string>(SITE_LOCALES);

/** A localized text: a non-empty object whose keys are all site locales and whose values are strings. */
export function isLocalized(value: unknown): value is Partial<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, text]) => LOCALES.has(key) && typeof text === 'string');
}

/** A call to action (has a `kind` among the actions and a localized `label`). */
export function isCta(
  value: unknown,
): value is { kind: string; label: unknown; pageId?: string; url?: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.kind === 'string' &&
    (CTA_KINDS as readonly string[]).includes(record.kind) &&
    isLocalized(record.label)
  );
}
