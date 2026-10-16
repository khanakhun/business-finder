import { customType } from 'drizzle-orm/pg-core';
import { ColumnValueError } from './errors.ts';

/** Serialises an embedding for pgvector after checking its dimension and that every value is finite. */
export function toPgVector(value: readonly number[], dimensions: number): string {
  if (value.length !== dimensions) {
    throw new ColumnValueError('vector', `expected ${dimensions} dimensions, got ${value.length}`);
  }
  if (!value.every(Number.isFinite)) throw new ColumnValueError('vector', 'values must be finite numbers');
  return `[${value.join(',')}]`;
}

export function fromPgVector(value: string): number[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === 'number')) {
    throw new ColumnValueError('vector', 'malformed vector from database');
  }
  return parsed;
}

/**
 * pgvector `vector(dimensions)` ⇄ `number[]`. A factory rather than a `customType` config because `toDriver`
 * does not receive the column config, and writes must be checked against the declared dimension.
 */
export function vector(dimensions: number, name?: string) {
  if (!Number.isInteger(dimensions) || dimensions < 1)
    throw new ColumnValueError('vector', 'dimensions must be ≥ 1');
  const column = customType<{ data: number[]; driverData: string }>({
    dataType: () => `vector(${dimensions})`,
    toDriver: (value) => toPgVector(value, dimensions),
    fromDriver: fromPgVector,
  });
  return name === undefined ? column() : column(name);
}
