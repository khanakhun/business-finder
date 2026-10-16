import { z } from 'zod';
import { EngineResultSchema } from './engine-result.ts';
import { SiteSpecSchema } from './spec/site.ts';

// JSON Schemas for agents and the runner image (BF-033): draft 2020-12, descriptions kept, shared shapes as $defs. Committed under
// generated/ by `pnpm site-schema:jsonschema`; a test fails when they are stale.

// Properties keep the schema's order (structured-output decoders write fields in it: `type` before `props`).
const exported = (schema: z.ZodType, id: string) => ({
  $id: `https://schemas.business-finder.dev/${id}.schema.json`,
  ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }),
});

/** File name (under generated/) → its content. */
export function jsonSchemaFiles(): Map<string, string> {
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return new Map([
    ['site-spec.schema.json', json(exported(SiteSpecSchema, 'site-spec'))],
    ['engine-result.schema.json', json(exported(EngineResultSchema, 'engine-result'))],
  ]);
}
