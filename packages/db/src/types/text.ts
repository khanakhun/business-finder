import { customType } from 'drizzle-orm/pg-core';
import { ColumnValueError } from './errors.ts';

/** `tsvector`, usually a generated column built with `f_unaccent()` + `to_tsvector()`. Read as its text form. */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

// PostgreSQL 16+ ltree labels: letters, digits, underscore and hyphen, separated by dots.
const LTREE_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

export function assertLtree(value: string): void {
  if (!LTREE_PATH.test(value)) {
    throw new ColumnValueError('ltree', `invalid path "${value}" (labels [A-Za-z0-9_-] separated by dots)`);
  }
}

/** `ltree` ⇄ dotted path string (`food.restaurant.seafood`). */
export const ltree = customType<{ data: string; driverData: string }>({
  dataType: () => 'ltree',
  toDriver(value) {
    assertLtree(value);
    return value;
  },
});

/** `citext` — case-insensitive text (emails, domains). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});
