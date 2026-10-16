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
  return Object.fromEntries(
    Object.entries(schemas).map(
      ([id, { $schema: _s, $id: _i, ...rest }]) => [id, asSchemaObject(rest)] as const,
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
