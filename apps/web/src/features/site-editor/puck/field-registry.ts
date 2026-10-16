import {
  AssetRefSchema,
  BLOCK_SCHEMAS,
  type Block,
  type BlockType,
  blockVariants,
  CtaActionSchema,
  type LocalizedText,
  type SiteSpec,
  validateSite,
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

/**
 * Optional and default wrappers peeled off. A nullable prop has no field: the editor's patches use `null` to remove a
 * key (BF-033 `updateBlockProps`), so a null value could not be saved.
 */
function unwrap(schema: z.ZodType, key: string): { inner: z.ZodType; optional: boolean } {
  let inner = schema;
  let optional = false;
  for (;;) {
    const def = defOf(inner);
    if (def.type === 'nullable') throw new UnsupportedFieldError(`No editor field for nullable "${key}".`);
    if (!['optional', 'default'].includes(def.type) || !def.innerType) return { inner, optional };
    optional = true;
    inner = def.innerType;
  }
}

/** A text in the site's languages: a record keyed by locale, of bounded strings. */
const isLocaleRecord = (def: Def) =>
  def.type === 'record' &&
  def.keyType !== undefined &&
  defOf(def.keyType).type === 'enum' &&
  def.valueType !== undefined &&
  defOf(def.valueType).type === 'string';

/** The field for one prop schema (`key` its name, `context` the block type for kind-specific strategies). */
export function describeField(key: string, schema: z.ZodType, context: BlockType): FieldSpec {
  const { inner, optional } = unwrap(schema, key);
  const def = defOf(inner);
  const common = { key, help: inner.description ?? schema.description, optional };
  // Strategies by identity first (shared schemas mean a meaning: an asset, an action), then by name, then by kind.
  if (inner === AssetRefSchema) return { ...common, kind: 'asset' };
  if (inner === CtaActionSchema) return { ...common, kind: 'cta' };
  if (key === 'factId') return { ...common, kind: 'fact' };
  if (key === 'factIds') return { ...common, kind: 'facts' };
  if (isLocaleRecord(def)) {
    const max = (def.valueType as unknown as { maxLength: number | null }).maxLength;
    if (!max) throw new UnsupportedFieldError(`"${context}.${key}" has no length limit.`);
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
      if (unwrap(element, key).inner === AssetRefSchema) return { ...common, kind: 'assets', min, max };
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

/** The site's images, each used once (a block needing more distinct images than the site has cannot be filled). */
function imagesOf(spec: SiteSpec): () => string {
  const images = spec.assets.filter((asset) => asset.kind === 'image');
  let next = 0;
  return () => {
    const asset = images[next++];
    if (!asset) throw new Unfillable();
    return asset.id;
  };
}

function filled<T>(fill: () => T): T | undefined {
  try {
    return fill();
  } catch (error) {
    if (error instanceof Unfillable) return undefined;
    throw error;
  }
}

/** A new item of a list field (what "Add item" starts from), or undefined when the site cannot fill one. */
export function defaultItem(field: FieldSpec & { kind: 'array' }, ctx: DefaultsContext): unknown {
  return filled(() => defaultFor(field.item, ctx, imagesOf(ctx.spec)));
}

/**
 * A new block of `type` for this site: its props (required fields filled: texts in the default language, the site's
 * images, a button to the home page) and the first layout the site can show as is (a layout needing an image the
 * block has not, say, comes after one without); undefined when the site cannot fill it (fewer images than the block
 * needs, a fact, or what the validator requires of the site for this block: hours, an address, a booking page…).
 */
export function defaultBlock(
  type: BlockType,
  ctx: DefaultsContext,
): { readonly variant: string; readonly props: Record<string, unknown> } | undefined {
  const props = filled(() => defaultsOf(describeBlockFields(type), ctx, imagesOf(ctx.spec)));
  const page = ctx.spec.pages[0];
  if (!props || !page) return undefined;
  const hosts = [...new Set(ctx.spec.assets.map((asset) => new URL(asset.url).hostname))];
  const at = page.blocks.length;
  const variants = blockVariants(type);
  for (const variant of variants) {
    const block = { id: 'candidate-block', type, variant, props } as Block;
    const candidate = {
      ...ctx.spec,
      pages: [{ ...page, blocks: [...page.blocks, block] }, ...ctx.spec.pages.slice(1)],
    };
    // What depends on the layout (an image, a button) or on the site (its requirements); texts are written later.
    const errors = validateSite(candidate, { assetHosts: hosts, mode: 'preview' }).filter(
      (issue) =>
        issue.severity === 'error' &&
        ['block_requirement', 'image_missing', 'cta_missing'].includes(issue.code) &&
        issue.path[0] === 'pages' &&
        issue.path[1] === 0 &&
        issue.path[3] === at,
    );
    // The site lacks what this block shows (every layout needs it).
    if (errors.some((issue) => issue.code === 'block_requirement')) return undefined;
    if (errors.length === 0) return { variant, props };
  }
  return { variant: variants[0] as string, props };
}

/** The props of `defaultBlock` (its first workable layout aside). */
export const defaultBlockProps = (type: BlockType, ctx: DefaultsContext) => defaultBlock(type, ctx)?.props;
