import type { ProblemFieldError } from '@bf/contracts';

// What makes an analytics query acceptable (BF-058, Specification): every metric and dimension is in the registry,
// at most one time dimension, filters on known dimensions only, a valid time zone, and a range of at most three
// years that ends after it starts. Each failure is a field error for the 422.

export interface QueryShape {
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly from: Date;
  readonly to: Date;
  readonly timeZone: string;
}

export interface KnownNames {
  readonly metrics: ReadonlySet<string>;
  readonly dimensions: ReadonlySet<string>;
  readonly timeDimensions: ReadonlySet<string>;
}

const MAX_RANGE_MS = 3 * 366 * 86_400_000;

const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export function queryProblems(query: QueryShape, known: KnownNames): ProblemFieldError[] {
  const problems: ProblemFieldError[] = [];
  query.metrics.forEach((metric, i) => {
    if (!known.metrics.has(metric))
      problems.push({ path: ['metrics', i], message: `Unknown metric ${metric}` });
  });
  query.dimensions.forEach((dimension, i) => {
    if (!known.dimensions.has(dimension))
      problems.push({ path: ['dimensions', i], message: `Unknown dimension ${dimension}` });
  });
  if (new Set(query.dimensions).size !== query.dimensions.length)
    problems.push({ path: ['dimensions'], message: 'A dimension appears twice' });
  if (query.dimensions.filter((dimension) => known.timeDimensions.has(dimension)).length > 1)
    problems.push({ path: ['dimensions'], message: 'At most one time dimension (day, week or month)' });
  for (const name of Object.keys(query.filters))
    if (!known.dimensions.has(name) || known.timeDimensions.has(name))
      problems.push({ path: ['filters', name], message: `Cannot filter on ${name}` });
  if (!(query.from < query.to))
    problems.push({ path: ['to'], message: 'The range must end after it starts' });
  else if (query.to.getTime() - query.from.getTime() > MAX_RANGE_MS)
    problems.push({ path: ['from'], message: 'At most three years at once' });
  if (!validZone(query.timeZone)) problems.push({ path: ['timeZone'], message: 'Unknown time zone' });
  return problems;
}
