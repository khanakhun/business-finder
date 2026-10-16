import {
  AssetRefSchema,
  BLOCK_SCHEMAS,
  type BlockType,
  CtaActionSchema,
  type LocalizedText,
  type SiteSpec,
} from '@bf/site-schema';
import type { z } from 'zod';

// The editor's fields come from the BF-033 schemas, not from a hand-kept list (BF-037): each prop schema is read
// once, by a strategy per schema kind, into a field description the Puck config renders. A kind with no strategy
// throws, so a block or prop added to the schema cannot ship without editor support (the registry test builds all).

interface Common {
  readonly key: string;
  /** The schema's description: what to write there. */
  readonly help: string | undefined;
  readonly optional: boolean;
}

export type FieldSpec = Common &
  (
    | { readonly kind: 'localizedText'; readonly max: number; readonly multiline: boolean }
    | { readonly kind: 'richText'; readonly max: number }
    | { readonly kind: 'text'; readonly max: number | undefined }
    | {
        readonly kind: 'number';
        readonly min: number | undefined;
        readonly max: number | undefined;
        readonly integer: boolean;
      }
    | { readonly kind: 'boolean' }
    | { readonly kind: 'enum'; readonly options: readonly string[] }
    | { readonly kind: 'asset' }
    | { readonly kind: 'assets'; readonly min: number | undefined; readonly max: number | undefined }
    | { readonly kind: 'cta' }
    | { readonly kind: 'fact' }
    | { readonly kind: 'facts' }
    | {
        readonly kind: 'array';
        readonly item: FieldSpec;
        readonly min: number | undefined;
        readonly max: number | undefined;
      }
    | { readonly kind: 'object'; readonly fields: readonly FieldSpec[] }
  );

export class UnsupportedFieldError extends Error {
  override readonly name = 'UnsupportedFieldError';
}

// Zod 4's definitions, read structurally (the editor reads, never builds, schemas).
interface Def {
  readonly type: string;
  readonly innerType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly shape?: Record<string, z.ZodType>;
  readonly keyType?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly entries?: Record<string, string>;
  readonly checks?: readonly {
    readonly _zod: { readonly def: { check: string; minimum?: number; maximum?: number } };
  }[];
}
const defOf = (schema: z.ZodType) => (schema as unknown as { _zod: { def: Def } })._zod.def;
const bound = (schema: z.ZodType, check: 'min_length' | 'max_length') => {
  const found = defOf(schema).checks?.find((entry) => entry._zod.def.check === check)?._zod.def;
  return check === 'min_length' ? found?.minimum : found?.maximum;
};

/** Optional, default and nullable wrappers peeled off. */
function unwrap(schema: z.ZodType): { inner: z.ZodType; optional: boolean } {
  let inner = schema;
  let optional = false;
  for (;;) {
    const def = defOf(inner);
    if (!['optional', 'default', 'nullable'].includes(def.type) || !def.innerType) return { inner, optional };
    optional = true;
    inner = def.innerType;
  }
}

const isLocaleRecord = (def: Def) =>
  def.type === 'record' && def.keyType !== undefined && defOf(def.keyType).type === 'enum';

/** The field for one prop schema (`key` its name, `context` the block type for kind-specific strategies). */
export function describeField(key: string, schema: z.ZodType, context: BlockType): FieldSpec {
  const { inner, optional } = unwrap(schema);
  const def = defOf(inner);
  const common = { key, help: inner.description ?? schema.description, optional };
  // Strategies by identity first (shared schemas mean a meaning: an asset, an action), then by name, then by kind.
  if (inner === AssetRefSchema) return { ...common, kind: 'asset' };
  if (inner === CtaActionSchema) return { ...common, kind: 'cta' };
  if (key === 'factId') return { ...common, kind: 'fact' };
  if (key === 'factIds') return { ...common, kind: 'facts' };
  if (isLocaleRecord(def)) {
    const max = (def.valueType as unknown as { maxLength: number | null }).maxLength ?? 0;
    if (context === 'rich_text' && key === 'body') return { ...common, kind: 'richText', max };
    return { ...common, kind: 'localizedText', max, multiline: max > 160 };
  }
  switch (def.type) {
    case 'string':
      return {
        ...common,
        kind: 'text',
        max: (inner as unknown as { maxLength: number | null }).maxLength ?? undefined,
      };
    case 'number': {
      const number = inner as unknown as { minValue: number | null; maxValue: number | null; isInt: boolean };
      return {
        ...common,
        kind: 'number',
        min: number.minValue ?? undefined,
        max: number.maxValue ?? undefined,
        integer: number.isInt,
      };
    }
    case 'boolean':
      return { ...common, kind: 'boolean' };
    case 'enum':
      return { ...common, kind: 'enum', options: Object.values(def.entries ?? {}) };
    case 'array': {
      const element = def.element as z.ZodType;
      const min = bound(inner, 'min_length');
      const max = bound(inner, 'max_length');
      if (unwrap(element).inner === AssetRefSchema) return { ...common, kind: 'assets', min, max };
      return { ...common, kind: 'array', item: describeField(key, element, context), min, max };
    }
    case 'object':
      return {
        ...common,
        kind: 'object',
        fields: Object.entries(def.shape ?? {}).map(([name, value]) => describeField(name, value, context)),
      };
    default:
      throw new UnsupportedFieldError(`No editor field for "${context}.${key}" (a ${def.type} schema).`);
  }
}

/** Every editable prop of a block type, in schema order. */
export function describeBlockFields(type: BlockType): readonly FieldSpec[] {
  const props = (BLOCK_SCHEMAS[type] as unknown as { shape: { props: z.ZodType } }).shape.props;
  const shape = defOf(props).shape ?? {};
  return Object.entries(shape).map(([key, schema]) => describeField(key, schema, type));
}

/** What a new block needs from the site to be valid; a type the site cannot fill is not offered. */
export interface DefaultsContext {
  readonly spec: SiteSpec;
  /** A placeholder for a required text, in the editor's language (the site's other languages are left to translate). */
  readonly placeholder: (field: FieldSpec) => string;
}

class Unfillable extends Error {}

function defaultFor(field: FieldSpec, ctx: DefaultsContext, assets: () => string): unknown {
  const text = (max: number): LocalizedText => ({
    [ctx.spec.defaultLocale]: ctx.placeholder(field).slice(0, max),
  });
  switch (field.kind) {
    case 'localizedText':
    case 'richText':
      return text(field.max);
    case 'text':
      return ctx.placeholder(field).slice(0, field.max ?? 60);
    case 'number':
      return field.min ?? 0;
    case 'boolean':
      return false;
    case 'enum':
      return field.options[0];
    case 'asset':
      return assets();
    case 'assets':
      return Array.from({ length: field.min ?? 1 }, assets);
    case 'cta': {
      const home = ctx.spec.pages[0];
      if (!home) throw new Unfillable();
      return { kind: 'page', label: text(30), pageId: home.id };
    }
    // A fact is never invented: a block that needs one waits for the fact registry (BF-040).
    case 'fact':
      throw new Unfillable();
    case 'facts':
      return [];
    case 'array':
      return Array.from({ length: field.min ?? 1 }, () => defaultFor(field.item, ctx, assets));
    case 'object':
      return defaultsOf(field.fields, ctx, assets);
  }
}

function defaultsOf(fields: readonly FieldSpec[], ctx: DefaultsContext, assets: () => string) {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.optional) continue;
    out[field.key] = defaultFor(field, ctx, assets);
  }
  return out;
}

/**
 * The props of a new block of `type` for this site (its required fields filled: texts in the default language, the
 * site's images in turn, a button to the home page), or undefined when the site cannot fill it (no image for a block
 * that needs one, a block that needs a fact).
 */
export function defaultBlockProps(
  type: BlockType,
  ctx: DefaultsContext,
): Record<string, unknown> | undefined {
  const images = ctx.spec.assets.filter((asset) => asset.kind === 'image');
  let next = 0;
  const assets = () => {
    const asset = images[next++ % Math.max(images.length, 1)];
    if (!asset) throw new Unfillable();
    return asset.id;
  };
  try {
    return defaultsOf(describeBlockFields(type), ctx, assets);
  } catch (error) {
    if (error instanceof Unfillable) return undefined;
    throw error;
  }
}
