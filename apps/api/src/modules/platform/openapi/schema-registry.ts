import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';

/** Schema (or `$ref`) object as typed by @nestjs/swagger, derived because the package only exports its root. */
export type SchemaObject = NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>[string];

/**
 * Schemas referenced by routes, by component id. `@ApiRoute` adds them; the OpenAPI builder turns them into
 * `components.schemas` (OpenAPI 3.1 = JSON Schema 2020-12).
 */
const components = new Map<string, z.ZodType>();

/** Component id from `.meta({ id })` on the schema (see @bf/contracts README). */
export function componentId(schema: z.ZodType): string | undefined {
  const meta = z.globalRegistry.get(schema);
  return typeof meta?.id === 'string' ? meta.id : undefined;
}

/** `$ref` for schemas with an id (registered as components), inline JSON Schema otherwise. */
export function schemaObject(schema: z.ZodType, io: 'input' | 'output'): SchemaObject {
  const id = componentId(schema);
  if (id) {
    const existing = components.get(id);
    if (existing && existing !== schema) throw new Error(`Two different schemas use the OpenAPI id "${id}"`);
    components.set(id, schema);
    return { $ref: `#/components/schemas/${id}` };
  }
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  });
  return asSchemaObject(json);
}

export function componentSchemas(): Record<string, SchemaObject> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of components) registry.add(schema, { id });
  const { schemas } = z.toJSONSchema(registry, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  });
  // Schemas with an id that no route references directly but several components share (e.g. ApiKeySummary inside
  // ApiKeyList and CreatedApiKey) land in a synthetic `__shared` document; promote them to real components.
  const { __shared: shared, ...named } = schemas;
  const promoted: Record<string, object> = { ...((shared?.$defs ?? {}) as Record<string, object>) };
  const all = Object.fromEntries(
    Object.entries({ ...named, ...promoted }).map(([id, json]) => {
      const { $schema: _s, $id: _i, ...rest } = json as Record<string, unknown>;
      return [id, rewriteSharedRefs(rest)] as const;
    }),
  );
  return Object.fromEntries(
    Object.entries(all).map(([id, json]) => [id, asSchemaObject(json as object)] as const),
  );
}

const SHARED_REF = '#/components/schemas/__shared#/$defs/';

function rewriteSharedRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteSharedRefs);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) =>
      key === '$ref' && typeof item === 'string' && item.startsWith(SHARED_REF)
        ? [key, `#/components/schemas/${item.slice(SHARED_REF.length)}`]
        : [key, rewriteSharedRefs(item)],
    ),
  );
}

/**
 * OpenAPI 3.1 schema objects *are* JSON Schema 2020-12; @nestjs/swagger's types still describe the 3.0 subset.
 * Safe: we emit `openapi: 3.1.0`.
 */
function asSchemaObject(json: object): SchemaObject {
  return json as SchemaObject;
}
