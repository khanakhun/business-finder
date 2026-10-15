import { geohashWithNeighbours } from './geohash.ts';
import type { NormalizedSource } from './normalized-source.ts';
import { significantTokens } from './string-similarity.ts';

// Stage 3 (BF-016): how candidates are found, and the advisory-lock keys that keep two concurrent ingestions of the
// same business from both creating it.

export const BLOCKING = {
  /** Neighbours within this radius need a name trigram similarity ≥ `minNameSimilarity`. */
  nearRadiusMeters: 75,
  minNameSimilarity: 0.35,
  /** Same normalized name within this radius. */
  sameNameRadiusMeters: 500,
  maxCandidates: 25,
} as const;

/** Two letters of the longest significant name token ("le tamarin" and "tamarin restaurant" → "ta"). */
export function namePrefix(normalizedName: string): string {
  const [longest] = [...significantTokens(normalizedName)].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  return (longest ?? normalizedName).slice(0, 2);
}

/**
 * Lock keys covering every candidate branch (a superset, so two concurrent ingestions of one place always share a
 * key): its phones, its site, its geohash cell and neighbours (whole cells: name variants can differ in every
 * token), and its normalized name (unlocated records match same-named businesses anywhere). Sorted, so
 * transactions lock in the same order.
 *
 * Lock protocol (ingestion, merge, split): blocking keys first, then `business:<id>` keys — each phase sorted, so
 * no two transactions can wait on each other in a cycle.
 */
export function blockingLockKeys(source: NormalizedSource): string[] {
  const keys = new Set<string>();
  for (const phone of source.phones) keys.add(`phone:${phone.e164}`);
  if (source.website) keys.add(`site:${source.website.matchKey}`);
  if (source.location) {
    for (const cell of geohashWithNeighbours(source.location.lat, source.location.lng))
      keys.add(`cell:${cell}`);
  }
  keys.add(`name:${source.name.normalized}`);
  return [...keys].sort();
}

/** `business:<id>` lock keys (second phase of the lock protocol). */
export const businessLockKeys = (ids: readonly string[]): string[] =>
  [...new Set(ids)].map((id) => `business:${id}`).sort();
