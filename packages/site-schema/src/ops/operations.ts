import { z } from 'zod';
import { AssetSchema } from '../spec/assets.ts';
import { BlockSchema } from '../spec/blocks/index.ts';
import { ContactSchema } from '../spec/contact.ts';
import { NavigationSchema } from '../spec/layout.ts';
import { LIMITS } from '../spec/limits.ts';
import { ElementIdSchema, localized, PageIdSchema, SiteLocaleSchema } from '../spec/localized.ts';
import { PageSchema } from '../spec/page.ts';
import { ThemeSchema } from '../spec/theme.ts';

// High-level edits of a site (BF-033): what the visual editor (BF-037), chat edits (BF-047) and `sitekit ops`
// (BF-042) send. Serializable (Command); each applies with checks and returns its inverse (undo).

const PathSchema = z
  .array(z.union([z.string().max(60), z.number().int().nonnegative()]))
  .min(1)
  .max(16)
  .describe('A path in the spec, e.g. ["pages", 0, "blocks", 1, "props", "title"].');

const op = <T extends string, S extends z.ZodRawShape>(name: T, shape: S, description: string) =>
  z
    .object({ op: z.literal(name), ...shape })
    .strict()
    .describe(description);

const BaseOperationSchema = z.discriminatedUnion('op', [
  op(
    'addPage',
    { page: PageSchema, index: z.number().int().nonnegative().optional() },
    'Add a page (at the end by default).',
  ),
  op('removePage', { pageId: PageIdSchema }, 'Remove a page and its menu items.'),
  op(
    'renamePage',
    {
      pageId: PageIdSchema,
      title: localized(LIMITS.pageTitle.max, 'The new page name.'),
      slug: z.string().optional(),
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
    { pageId: PageIdSchema, block: BlockSchema, index: z.number().int().nonnegative().optional() },
    'Add a block to a page (at the end by default).',
  ),
  op('removeBlock', { pageId: PageIdSchema, blockId: ElementIdSchema }, 'Remove a block.'),
  op(
    'moveBlock',
    {
      pageId: PageIdSchema,
      blockId: ElementIdSchema,
      toPageId: PageIdSchema.optional(),
      index: z.number().int().nonnegative(),
    },
    'Move a block within its page or to another page.',
  ),
  op(
    'updateBlockProps',
    { pageId: PageIdSchema, blockId: ElementIdSchema, props: z.record(z.string(), z.unknown()) },
    'Change some props of a block (deep merge; null removes a prop).',
  ),
  op(
    'setBlockProps',
    { pageId: PageIdSchema, blockId: ElementIdSchema, props: z.record(z.string(), z.unknown()) },
    "Replace a block's props.",
  ),
  op(
    'setBlockVariant',
    { pageId: PageIdSchema, blockId: ElementIdSchema, variant: z.string() },
    "Change a block's variant.",
  ),
  op('setTheme', { theme: ThemeSchema }, 'Replace the theme.'),
  op('setContact', { contact: ContactSchema }, 'Replace the contact facts.'),
  op('setNavigation', { navigation: NavigationSchema }, 'Replace the menu.'),
  op(
    'updateText',
    { path: PathSchema, locale: SiteLocaleSchema, value: z.string().nullable() },
    'Set the text of one locale of a localized field (null removes it).',
  ),
  op('addAsset', { asset: AssetSchema, index: z.number().int().nonnegative().optional() }, 'Add an asset.'),
  op('removeAsset', { assetId: ElementIdSchema }, 'Remove an asset nothing uses.'),
  op(
    'assignAsset',
    { path: PathSchema, assetId: ElementIdSchema.nullable() },
    'Point an asset field (…AssetId, or an entry of assetIds) to an asset; null clears it.',
  ),
]);

export type BaseOperation = z.infer<typeof BaseOperationSchema>;
export type Operation = BaseOperation | { readonly op: 'batch'; readonly ops: readonly Operation[] };

export const OperationSchema: z.ZodType<Operation> = z.lazy(() =>
  z.union([
    BaseOperationSchema,
    z.object({ op: z.literal('batch'), ops: z.array(OperationSchema).min(1).max(200) }).strict(),
  ]),
);

export const OPERATION_ERROR_CODES = [
  'page_not_found',
  'block_not_found',
  'asset_not_found',
  'asset_in_use',
  'duplicate_id',
  'invalid_order',
  'invalid_path',
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
