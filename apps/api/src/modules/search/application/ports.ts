import type { ParseSearchIntentResponse } from '@bf/contracts';

/** Parsed intents per (workspace, normalized prompt, locale, country) for an hour. */
export interface SearchIntentCache {
  get(key: string): Promise<ParseSearchIntentResponse | undefined>;
  set(key: string, value: ParseSearchIntentResponse, ttlSeconds: number): Promise<void>;
}
export const SEARCH_INTENT_CACHE = Symbol('SearchIntentCache');
