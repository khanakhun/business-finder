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
 * Lock keys covering every way this record can match: its phones, its site (match key), and its geohash cell plus
 * neighbours combined with a name prefix. Sorted, so concurrent transactions lock in the same order (no deadlocks).
 */
export function blockingLockKeys(source: NormalizedSource): string[] {
  const keys = new Set<string>();
  for (const phone of source.phones) keys.add(`phone:${phone.e164}`);
  if (source.website) keys.add(`site:${source.website.matchKey}`);
  if (source.location) {
    const prefix = namePrefix(source.name.normalized);
    for (const cell of geohashWithNeighbours(source.location.lat, source.location.lng))
      keys.add(`cell:${cell}:${prefix}`);
  } else {
    // Without coordinates, the name is the only shared handle.
    keys.add(`name:${source.name.normalized}`);
  }
  return [...keys].sort();
}
