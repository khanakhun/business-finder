import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jsonSchemaFiles } from './json-schema.ts';

describe('JSON Schema export', () => {
  it('matches the committed files (run pnpm site-schema:jsonschema)', () => {
    for (const [file, content] of jsonSchemaFiles()) {
      expect(readFileSync(new URL(`../generated/${file}`, import.meta.url), 'utf8'), file).toBe(content);
    }
  });

  it('is draft 2020-12, keeps the descriptions and refuses unknown properties', () => {
    const spec = JSON.parse(jsonSchemaFiles().get('site-spec.schema.json') ?? '{}');
    expect(spec.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    const root = spec.$ref ? spec.$defs[spec.$ref.split('/').at(-1)] : spec;
    expect(root.additionalProperties).toBe(false);
    expect(root.required).toEqual(expect.arrayContaining(['schemaVersion', 'locales', 'pages', 'contact']));
    expect(JSON.stringify(spec)).toContain('Never fabricate a testimonial');
    // Shared shapes are defined once.
    expect(Object.keys(spec.$defs)).toEqual(
      expect.arrayContaining(['CtaAction', 'Price', 'Asset', 'HeroBlock']),
    );
    // Fields in the schema's order: a block's type before its props.
    expect(Object.keys(spec.$defs.HeroBlock.properties)).toEqual(['id', 'type', 'variant', 'props']);
  });
});
