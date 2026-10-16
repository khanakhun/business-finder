import type { ParseSearchIntentOutput } from '@bf/ai';
import {
  type Locale,
  PAIN_SIGNALS,
  PIPELINE_STATUSES,
  SCORE_TIERS,
  SEARCH_INTENT_WARNINGS,
  type SearchFilters,
  type SearchIntent,
} from '@bf/contracts';

// Model (or fallback) output → a valid SearchIntent (BF-021): categories restricted to the candidates and mapped
// from slugs to ids, descendants collapsed into their ancestor, numbers clamped and ordered, lists deduplicated.

export interface IntentCategory {
  readonly id: string;
  readonly slug: string;
  /** Dotted slug path from the root ("food_drink.restaurant.pizzeria"). */
  readonly path: string;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: number | null) => (value !== null && Number.isFinite(value) ? value : null);
const unique = <T>(values: readonly T[]) => [...new Set(values)];
const trimList = (values: readonly string[], maxItems: number, maxLength: number) =>
  unique(values.map((v) => v.trim().slice(0, maxLength)).filter(Boolean)).slice(0, maxItems);

/** Keeps candidate categories only, drops any category whose ancestor is also selected. */
export function groundCategories(
  ids: readonly string[],
  candidates: ReadonlyMap<string, IntentCategory>,
): { readonly categories: IntentCategory[]; readonly invalid: number } {
  const known = unique(ids).flatMap((slug) => {
    const category = candidates.get(slug);
    return category ? [category] : [];
  });
  const categories = known.filter(
    (category) => !known.some((other) => other !== category && category.path.startsWith(`${other.path}.`)),
  );
  return { categories, invalid: unique(ids).length - known.length };
}

function orderedRange(
  min: number | null,
  max: number | null,
  lower: number,
  upper: number,
  round: (n: number) => number,
): [number | null, number | null] {
  const a = finite(min) === null ? null : round(clamp(min as number, lower, upper));
  const b = finite(max) === null ? null : round(clamp(max as number, lower, upper));
  return a !== null && b !== null && a > b ? [b, a] : [a, b];
}

export function cleanFilters(raw: ParseSearchIntentOutput['filters']): SearchFilters {
  const tenth = (n: number) => Math.round(n * 10) / 10;
  // A rating of 0 (or below) means "no rating filter", not "at least one star".
  const rating = (n: number | null) => (n !== null && n > 0 ? n : null);
  const [minRating, maxRating] = orderedRange(rating(raw.minRating), rating(raw.maxRating), 1, 5, tenth);
  const [minReviews, maxReviews] = orderedRange(raw.minReviews, raw.maxReviews, 0, 1_000_000, Math.round);
  const minScore = finite(raw.minScore);
  const days = finite(raw.addedWithinDays);
  const emailVerified = raw.emailVerified === true ? true : null;
  return {
    website: raw.website,
    minRating,
    maxRating,
    minReviews,
    maxReviews,
    // A verified email implies an email.
    hasEmail: emailVerified ? true : raw.hasEmail,
    hasPhone: raw.hasPhone,
    emailVerified,
    languages: unique(
      raw.languages.map((l) => l.trim().toLowerCase()).filter((l) => /^[a-z]{2}$/.test(l)),
    ).slice(0, 10),
    priceLevels: unique(raw.priceLevels.map(Math.round).filter((p) => p >= 1 && p <= 4)).sort(),
    painSignals: unique(raw.painSignals.filter((p) => PAIN_SIGNALS.includes(p))),
    scoreProfile: null,
    minScore: minScore === null ? null : Math.round(clamp(minScore, 0, 100)),
    tiers: unique(raw.tiers.filter((t) => SCORE_TIERS.includes(t))),
    pipelineStatuses: unique(raw.pipelineStatuses.filter((s) => PIPELINE_STATUSES.includes(s))),
    tags: trimList(raw.tags, 20, 50),
    addedWithinDays: days === null ? null : Math.round(clamp(days, 1, 3_650)),
  };
}

export function toSearchIntent(
  output: ParseSearchIntentOutput,
  context: { readonly candidates: ReadonlyMap<string, IntentCategory>; readonly language: Locale },
): SearchIntent {
  const { categories, invalid } = groundCategories(output.categoryIds, context.candidates);
  const warnings = trimList(output.warnings, 8, 300);
  if (invalid > 0) warnings.unshift(SEARCH_INTENT_WARNINGS.invalidCategories);
  const limit = finite(output.limit);
  const location = output.locationText?.trim().slice(0, 200);
  const clarification = output.needsClarification;
  const options = clarification ? trimList(clarification.options, 6, 200) : [];
  return {
    mode: output.mode,
    categories: {
      ids: categories.slice(0, 20).map((c) => c.id),
      // DECISION(BF-021): a category always includes its subcategories ("restaurants" → pizzerias too).
      includeDescendants: true,
    },
    keywords: trimList(output.keywords, 10, 60),
    location: location ? { text: location, resolution: null } : null,
    filters: cleanFilters(output.filters),
    sort: output.sort,
    limit: limit === null ? null : Math.round(clamp(limit, 1, 2_000)),
    needsClarification: clarification?.question.trim()
      ? {
          question: clarification.question.trim().slice(0, 300),
          ...(options.length > 0 ? { options } : {}),
        }
      : null,
    confidence: clamp(Number.isFinite(output.confidence) ? output.confidence : 0, 0, 1),
    warnings: warnings.slice(0, 10),
    language: context.language,
  };
}
