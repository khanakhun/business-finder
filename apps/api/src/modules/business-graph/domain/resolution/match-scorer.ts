import type { MatchFeature, MatchScore, SourceProvider } from '@bf/contracts';
import { distanceMeters } from './geohash.ts';
import type { NormalizedSource } from './normalized-source.ts';
import { nameSimilarity } from './string-similarity.ts';

// Stage 4 (BF-016): an explainable, additive score of "this source record describes that golden record". Each
// feature adds `weight × value`; conflicts subtract. Totals are clamped to [0, 1].

/** What we know about a candidate golden record (from the business row, its contacts and its sources). */
export interface CandidateProfile {
  readonly businessId: string;
  readonly normalizedName: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  /** E.164 phones (primary phone and phone contacts). */
  readonly phones: readonly string[];
  /** Site match keys (registrable domain, or host + first path segment on shared hosts). */
  readonly siteKeys: readonly string[];
  /** Primary category path (`food_drink.restaurant`), if classified. */
  readonly categoryPath: string | null;
  readonly addressTokens: readonly string[];
  /** Providers already linked (with their refs). */
  readonly sources: ReadonlyArray<{ readonly provider: SourceProvider; readonly providerRef: string }>;
}

export interface MatchWeights {
  readonly name: number;
  readonly distance: number;
  readonly phone: number;
  readonly website: number;
  readonly category: number;
  readonly address: number;
  readonly phoneConflict: number;
  readonly websiteConflict: number;
  readonly sameProvider: number;
}

export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  name: 0.4,
  distance: 0.25,
  phone: 0.3,
  website: 0.25,
  category: 0.1,
  address: 0.05,
  phoneConflict: -0.1,
  websiteConflict: -0.1,
  // A provider rarely lists one place twice: a second Google place nearby is usually a neighbour.
  sameProvider: -0.2,
};

/** 1 within 25 m, falling linearly to 0 at 500 m. */
export function distanceDecay(meters: number): number {
  if (meters <= 25) return 1;
  if (meters >= 500) return 0;
  return 1 - (meters - 25) / 475;
}

/** Same category 1, ancestor/descendant 0.7, siblings 0.4, same top-level group 0.2, unrelated 0; unknown 0.5. */
export function categoryCompatibility(a: string | null, b: string | null): number {
  if (!a || !b) return 0.5;
  if (a === b) return 1;
  if (a.startsWith(`${b}.`) || b.startsWith(`${a}.`)) return 0.7;
  const parent = (path: string) => path.split('.').slice(0, -1).join('.');
  if (parent(a) && parent(a) === parent(b)) return 0.4;
  return a.split('.')[0] === b.split('.')[0] ? 0.2 : 0;
}

/** Street-ish tokens of an address (≥ 3 letters, no numbers), for overlap scoring. */
export function addressTokens(formatted: string | null | undefined): string[] {
  if (!formatted) return [];
  return [
    ...new Set(
      formatted
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((t) => t.length >= 3),
    ),
  ].sort();
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function scoreMatch(
  source: NormalizedSource,
  sourceCategoryPath: string | null,
  candidate: CandidateProfile,
  weights: MatchWeights = DEFAULT_MATCH_WEIGHTS,
): MatchScore {
  const features: Array<{ feature: MatchFeature; value: number; contribution: number }> = [];
  const reasons: string[] = [];
  const add = (feature: MatchFeature, value: number, contribution: number, reason?: string) => {
    features.push({ feature, value: round(value), contribution: round(contribution) });
    if (reason) reasons.push(reason);
  };

  const name = nameSimilarity(source.name.normalized, candidate.normalizedName);
  add('name', name, weights.name * name, `name similarity ${round(name)}`);

  if (source.location && candidate.location) {
    const meters = distanceMeters(source.location, candidate.location);
    const decay = distanceDecay(meters);
    add('distance', meters, weights.distance * decay, `${Math.round(meters)} m apart`);
  }

  const sourcePhones = source.phones.map((p) => p.e164);
  const sharedPhone = sourcePhones.find((p) => candidate.phones.includes(p));
  if (sharedPhone) add('phone', 1, weights.phone, 'same phone number');
  else if (sourcePhones.length > 0 && candidate.phones.length > 0) {
    add('phoneConflict', 1, weights.phoneConflict, 'different phone numbers');
  }

  const siteKey = source.website?.matchKey;
  if (siteKey && candidate.siteKeys.includes(siteKey)) add('website', 1, weights.website, 'same website');
  else if (siteKey && !source.website?.shared && candidate.siteKeys.length > 0) {
    add('websiteConflict', 1, weights.websiteConflict, 'different websites');
  }

  const compatibility = categoryCompatibility(sourceCategoryPath, candidate.categoryPath);
  add('category', compatibility, weights.category * compatibility);

  const tokens = addressTokens(source.address?.formatted);
  if (tokens.length > 0 && candidate.addressTokens.length > 0) {
    const shared = tokens.filter((t) => candidate.addressTokens.includes(t)).length;
    const overlap = shared / new Set([...tokens, ...candidate.addressTokens]).size;
    add('address', overlap, weights.address * overlap);
  }

  if (
    source.provider !== 'manual' &&
    candidate.sources.some((s) => s.provider === source.provider && s.providerRef !== source.providerRef)
  ) {
    add('sameProvider', 1, weights.sameProvider, `already has another ${source.provider} record`);
  }

  const total = Math.min(
    1,
    Math.max(
      0,
      features.reduce((sum, f) => sum + f.contribution, 0),
    ),
  );
  return { total: round(total), features, reasons };
}
