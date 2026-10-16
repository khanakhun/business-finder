import { describe, expect, it } from 'vitest';
import { jsonSchemaFiles } from './json-schema.ts';

type Node = Record<string, unknown>;

/** Every property of every object in the schema, with whether it (or its $ref target) has a description. */
function undocumented(root: Node): string[] {
  const defs = (root.$defs ?? {}) as Record<string, Node>;
  const missing = new Set<string>();
  const described = (node: Node): boolean => {
    if (typeof node.description === 'string') return true;
    if (typeof node.$ref === 'string') return described(defs[node.$ref.split('/').at(-1) ?? ''] ?? {});
    return false;
  };
  const visit = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) visit(item, `${path}[${i}]`);
      return;
    }
    const record = node as Node;
    for (const [name, prop] of Object.entries((record.properties ?? {}) as Record<string, Node>)) {
      if (!described(prop)) missing.add(`${path}.${name}`);
    }
    for (const [key, value] of Object.entries(record)) if (key !== '$defs') visit(value, `${path}/${key}`);
  };
  visit(root, '');
  for (const [name, def] of Object.entries(defs)) visit(def, `#${name}`);
  return [...missing].sort();
}

describe('JSON Schema documentation', () => {
  it.each(['site-spec.schema.json', 'engine-result.schema.json'])(
    'describes every property of %s',
    (file) => {
      expect(undocumented(JSON.parse(jsonSchemaFiles().get(file) ?? '{}'))).toEqual([]);
    },
  );

  it('bounds every text: each string has a pattern, a format, an enum or a constant', () => {
    const root = JSON.parse(jsonSchemaFiles().get('site-spec.schema.json') ?? '{}') as Node;
    const loose: string[] = [];
    const visit = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const [i, item] of node.entries()) visit(item, `${path}[${i}]`);
        return;
      }
      const record = node as Node;
      if (
        record.type === 'string' &&
        !record.pattern &&
        !record.format &&
        !record.enum &&
        record.const === undefined
      ) {
        loose.push(path);
      }
      for (const [key, value] of Object.entries(record)) visit(value, `${path}/${key}`);
    };
    visit(root, '');
    expect(loose).toEqual([]);
  });
});
