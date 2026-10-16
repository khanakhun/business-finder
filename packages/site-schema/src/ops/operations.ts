import { z } from 'zod';
import { AssetSchema } from '../spec/assets.ts';
import { BlockSchema } from '../spec/blocks/index.ts';
import { ContactSchema } from '../spec/contact.ts';
import { LayoutSchema, NavigationSchema } from '../spec/layout.ts';
import { LIMITS } from '../spec/limits.ts';
import { ElementIdSchema, localized, PageIdSchema, SiteLocaleSchema } from '../spec/localized.ts';
import { PageSchema } from '../spec/page.ts';
import { SiteSpecSchema } from '../spec/site.ts';
import { ThemeSchema } from '../spec/theme.ts';

// High-level edits of a site (BF-033): what the visual editor (BF-037), chat edits (BF-047) and `sitekit ops`
// (BF-042) send — possibly written by a model. Serializable (Command); each applies with checks and returns its
// inverse (undo). Untrusted: paths name own fields only, batches are flat and bounded.

/** Keys that would reach an object's prototype: never a path step. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const PathStepSchema = z.union([
  z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/)
    .refine((step) => !FORBIDDEN_KEYS.has(step), { message: 'Not a field of the spec' }),
  z.number().int().nonnegative().max(1000),
]);

const PathSchema = z
  .array(PathStepSchema)
  .min(1)
  .max(16)
  .describe('A path in the spec, e.g. ["pages", 0, "blocks", 1, "props", "title"].');

const op = <T extends string, S extends z.ZodRawShape>(name: T, shape: S, description: string) =>
  z
    .object({ op: z.literal(name), ...shape })
    .strict()
    .describe(description);

const index = z.number().int().nonnegative().max(1000);

export const BaseOperationSchema = z.discriminatedUnion('op', [
  op(
    'addPage',
    { page: PageSchema, index: index.optional(), navigation: NavigationSchema.optional() },
    'Add a page (at the end by default), and set the menu with it when given.',
  ),
  op(
    'removePage',
    { pageId: PageIdSchema, navigation: NavigationSchema.optional() },
    'Remove a page and its menu items (or set the menu without it, when given). Refused while an action or a ' +
      'rich-text link still opens it.',
  ),
  op(
    'renamePage',
    {
      pageId: PageIdSchema,
      title: localized(LIMITS.pageTitle.max, 'The new page name.'),
      slug: z.string().max(60).optional(),
    },
    'Rename a page (and change its slug).',
  ),
  op(
    'reorderPages',
    { order: z.array(PageIdSchema).min(1).max(8) },
    'Put the pages in this order (every page once).',
  ),
  op(
    'addBlock',
    { pageId: PageIdSchema, block: BlockSchema, index: index.optional() },
    'Add a block to a page (at the end by default).',
  ),
  op('removeBlock', { pageId: PageIdSchema, blockId: ElementIdSchema }, 'Remove a block.'),
  op(
    'moveBlock',
    { pageId: PageIdSchema, blockId: ElementIdSchema, toPageId: PageIdSchema.optional(), index },
    'Move a block within its page or to another page.',
  ),
  op(
    'updateBlockProps',
    { pageId: PageIdSchema, blockId: ElementIdSchema, props: z.record(z.string(), z.unknown()) },
    'Change some props of a block: objects merge deeply, arrays are replaced in full, null removes a prop.',
  ),
  op(
    'setBlockProps',
    { pageId: PageIdSchema, blockId: ElementIdSchema, props: z.record(z.string(), z.unknown()) },
    "Replace a block's props.",
  ),
  op(
    'setBlockVariant',
    { pageId: PageIdSchema, blockId: ElementIdSchema, variant: z.string().max(40) },
    "Change a block's variant.",
  ),
  op('setTheme', { theme: ThemeSchema }, 'Replace the theme.'),
  op('setContact', { contact: ContactSchema }, 'Replace the contact facts.'),
  op('setNavigation', { navigation: NavigationSchema }, 'Replace the menu.'),
  op('setLayout', { layout: LayoutSchema }, 'Replace the header and footer.'),
  op('setSettings', { settings: SiteSpecSchema.shape.settings }, 'Replace the site settings.'),
  op(
    'updateText',
    { path: PathSchema, locale: SiteLocaleSchema, value: z.string().max(5000).nullable() },
    'Set the text of one locale of a localized field (null removes it).',
  ),
  op('addAsset', { asset: AssetSchema, index: index.optional() }, 'Add an asset.'),
  op('removeAsset', { assetId: ElementIdSchema }, 'Remove an asset nothing uses.'),
  op(
    'assignAsset',
    { path: PathSchema, assetId: ElementIdSchema.nullable() },
    'Point an asset field (…AssetId) to an asset; null clears it.',
  ),
  op(
    'insertAssetRef',
    { path: PathSchema, index, assetId: ElementIdSchema },
    'Insert an asset into an asset list (assetIds) at an index.',
  ),
  op(
    'removeAssetRef',
    { path: PathSchema, index },
    'Remove the entry at an index of an asset list (assetIds).',
  ),
]);

export type BaseOperation = z.infer<typeof BaseOperationSchema>;
export type Operation = BaseOperation | { readonly op: 'batch'; readonly ops: readonly BaseOperation[] };

/** The most operations a batch holds (each applies to a copy of the site). */
export const MAX_BATCH = 200;

export const OperationSchema: z.ZodType<Operation> = z.union([
  BaseOperationSchema,
  z
    .object({ op: z.literal('batch'), ops: z.array(BaseOperationSchema).max(MAX_BATCH) })
    .strict()
    .describe('Several operations, all or nothing (flat: a batch holds no batch).'),
]);

export const OPERATION_ERROR_CODES = [
  'page_not_found',
  'page_in_use',
  'block_not_found',
  'asset_not_found',
  'asset_in_use',
  'duplicate_id',
  'invalid_order',
  'invalid_path',
  'too_many',
  'invalid_result',
] as const;

/** An operation that cannot apply: nothing changed. */
export class OperationError extends Error {
  constructor(
    readonly code: (typeof OPERATION_ERROR_CODES)[number],
    message: string,
    readonly details: readonly {
      readonly path: readonly (string | number)[];
      readonly message: string;
    }[] = [],
  ) {
    super(message);
    this.name = 'OperationError';
  }
}
