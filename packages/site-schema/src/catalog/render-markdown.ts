import { z } from 'zod';
import { BLOCK_SCHEMAS, BLOCK_TYPES, type BlockType } from '../spec/blocks/index.ts';
import { CATALOG, thumbnailPath } from './catalog.ts';

// The catalog as markdown (BF-033): one file per block and an index, written to the agents' workspaces (BF-040,
// BF-042). Props come from the block's JSON Schema: their types, limits and descriptions.

type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: JsonSchema | boolean;
  anyOf?: JsonSchema[];
  $ref?: string;
};

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

type Defs = Readonly<Record<string, JsonSchema>>;

/** A schema with its `$ref` (to the shared shapes of the documented schema) followed. */
const resolve = (schema: JsonSchema, defs: Defs): JsonSchema => {
  const target = schema.$ref ? defs[schema.$ref.split('/').at(-1) ?? ''] : undefined;
  if (!target) return schema;
  const { $ref: _ref, ...own } = schema;
  return { ...target, ...own };
};

function describe(raw: JsonSchema, defs: Defs): string {
  const schema = resolve(raw, defs);
  if (schema.enum) return `one of ${schema.enum.map((v) => `\`${String(v)}\``).join(', ')}`;
  if (schema.type === 'array') {
    const bounds =
      schema.minItems !== undefined || schema.maxItems !== undefined
        ? ` (${schema.minItems ?? 0}–${schema.maxItems ?? '…'})`
        : '';
    return `list${bounds} of ${schema.items ? describe(schema.items, defs) : 'values'}`;
  }
  if (
    schema.type === 'object' &&
    schema.additionalProperties &&
    typeof schema.additionalProperties === 'object' &&
    !schema.properties
  ) {
    return 'text per locale';
  }
  if (schema.type === 'object') return 'object';
  if (schema.type === 'string' && schema.maxLength) return `text (≤ ${schema.maxLength})`;
  return schema.type ?? (schema.anyOf ? 'one of several shapes' : 'value');
}

function propRows(schema: JsonSchema, defs: Defs, prefix = ''): string[] {
  const rows: string[] = [];
  for (const [name, raw] of Object.entries(schema.properties ?? {})) {
    const prop = resolve(raw, defs);
    const required = schema.required?.includes(name) ? 'yes' : '';
    rows.push(
      `| \`${prefix}${name}\` | ${cell(describe(prop, defs))} | ${required} | ${cell(prop.description ?? '')} |`,
    );
    const nested = prop.type === 'array' && prop.items ? resolve(prop.items, defs) : prop;
    if (nested?.type === 'object' && nested.properties)
      rows.push(...propRows(nested, defs, `${prefix}${name}${prop.type === 'array' ? '[]' : ''}.`));
  }
  return rows;
}

export function blockMarkdown(type: BlockType): string {
  const entry = CATALOG[type];
  const props = z.toJSONSchema(BLOCK_SCHEMAS[type].shape.props, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchema & { $defs?: Record<string, JsonSchema> };
  const defs: Defs = props.$defs ?? {};
  return [
    `# ${entry.title} (\`${type}\`)`,
    '',
    entry.purpose,
    '',
    '## Use it',
    '',
    ...entry.use.map((line) => `- ${line}`),
    '',
    '## Avoid',
    '',
    ...entry.avoid.map((line) => `- ${line}`),
    '',
    '## Variants',
    '',
    '| Variant | When | Preview |',
    '|---|---|---|',
    ...Object.entries(entry.variants).map(
      ([variant, text]) => `| \`${variant}\` | ${cell(text)} | \`${thumbnailPath(type, variant)}\` |`,
    ),
    '',
    '## Props',
    '',
    '| Prop | Type | Required | What to write |',
    '|---|---|---|---|',
    ...propRows(props, defs),
    '',
    '## Examples',
    '',
    `- Good: ${entry.good.en} / ${entry.good.fr}`,
    `- Bad: ${entry.bad.en} / ${entry.bad.fr}`,
    '',
  ].join('\n');
}

/** File name (under generated/catalog/) → content. */
export function catalogFiles(): Map<string, string> {
  const files = new Map<string, string>();
  const index = [
    '# Block catalog',
    '',
    'Every block a page can use (generated from `@bf/site-schema`; do not edit). Each page starts with one hero.',
    '',
    '| Block | Purpose |',
    '|---|---|',
    ...BLOCK_TYPES.map((type) => `| [\`${type}\`](${type}.md) | ${cell(CATALOG[type].purpose)} |`),
    '',
  ].join('\n');
  files.set('README.md', index);
  for (const type of BLOCK_TYPES) files.set(`${type}.md`, blockMarkdown(type));
  return files;
}
