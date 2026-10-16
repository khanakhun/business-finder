import { z } from 'zod';
import { EngineResultSchema } from './engine-result.ts';
import { SiteSpecSchema } from './spec/site.ts';

// JSON Schemas for agents and the runner image (BF-033): draft 2020-12, descriptions kept. Committed under
// generated/ by `pnpm site-schema:jsonschema`; a test fails when they are stale.

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
};

const exported = (schema: z.ZodType, id: string) =>
  sortKeys({
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }),
    $id: `https://schemas.business-finder.dev/${id}.schema.json`,
  });

/** File name (under generated/) → its content. */
export function jsonSchemaFiles(): Map<string, string> {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return new Map([
    ['site-spec.schema.json', json(exported(SiteSpecSchema, 'site-spec'))],
    ['engine-result.schema.json', json(exported(EngineResultSchema, 'engine-result'))],
  ]);
}
