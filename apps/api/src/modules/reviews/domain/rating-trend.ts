import type { RatingObservationSource } from '@bf/contracts';
import type { RatingSummary } from './insights.ts';

// Rating trend (BF-029, pure): compares the earliest and latest average a source reported, when its observations
// span long enough to mean something. Observations only exist within the source's retention (Google: 30 days), so
// a trend is often `unknown` — never guessed.

export interface RatingObservation {
  readonly source: RatingObservationSource;
  readonly avg: number;
  readonly count: number;
  readonly observedAt: Date;
}

/** Observations must span this long before a trend is read. */
export const TREND_MIN_SPAN_DAYS = 14;
/** Average change (stars) below which the rating is flat. */
export const TREND_MIN_DELTA = 0.1;

const DAY_MS = 86_400_000;

export function ratingSummary(observations: readonly RatingObservation[]): RatingSummary {
  if (observations.length === 0) return { snapshot: null, trend: 'unknown' };
  const sorted = [...observations].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const latest = sorted[sorted.length - 1] as RatingObservation;
  const snapshot = { avg: latest.avg, count: latest.count, observedAt: latest.observedAt.toISOString() };
  // One source's series only (sources round differently); the one observed most often.
  const bySource = new Map<RatingObservationSource, RatingObservation[]>();
  for (const observation of sorted) {
    bySource.set(observation.source, [...(bySource.get(observation.source) ?? []), observation]);
  }
  const series = [...bySource.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last || series.length < 2) return { snapshot, trend: 'unknown' };
  if (last.observedAt.getTime() - first.observedAt.getTime() < TREND_MIN_SPAN_DAYS * DAY_MS) {
    return { snapshot, trend: 'unknown' };
  }
  const delta = last.avg - first.avg;
  const trend = delta >= TREND_MIN_DELTA - 1e-9 ? 'up' : delta <= -TREND_MIN_DELTA + 1e-9 ? 'down' : 'flat';
  return { snapshot, trend };
}
