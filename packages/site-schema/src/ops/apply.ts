import type { Asset } from '../spec/assets.ts';
import type { Block } from '../spec/blocks/index.ts';
import type { Page } from '../spec/page.ts';
import { type SiteSpec, SiteSpecSchema } from '../spec/site.ts';
import { type FactRegistry, validateFacts } from '../validate/facts.ts';
import type { Issue } from '../validate/issues.ts';
import { parseRichText } from '../validate/rich-text.ts';
import { type ValidateOptions, validateSite } from '../validate/semantic.ts';
import { isCta, isLocalized, walk } from '../validate/walk.ts';
import { type BaseOperation, MAX_BATCH, type Operation, OperationError } from './operations.ts';

// Applying operations (BF-033): on a copy, with the operation's own checks, then the schema (once per call, after a
// whole batch); the result is the parsed spec, and the inverse restores the input exactly. Never changes its input;
// every failure is an OperationError.

export interface Applied {
  readonly spec: SiteSpec;
  readonly inverse: Operation;
}

type Path = readonly (string | number)[];
type Container = Record<string, unknown> | unknown[];

const copy = <T>(value: T): T => structuredClone(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

function pageIndex(spec: SiteSpec, pageId: string): number {
  const i = spec.pages.findIndex((page) => page.id === pageId);
  if (i < 0) throw new OperationError('page_not_found', `There is no page "${pageId}".`);
  return i;
}

function blockAt(
  spec: SiteSpec,
  pageId: string,
  blockId: string,
): { page: Page; index: number; block: Block } {
  const page = spec.pages[pageIndex(spec, pageId)] as Page;
  const index = page.blocks.findIndex((block) => block.id === blockId);
  if (index < 0)
    throw new OperationError('block_not_found', `There is no block "${blockId}" on page "${pageId}".`);
  return { page, index, block: page.blocks[index] as Block };
}

function elementIds(spec: SiteSpec): Set<string> {
  return new Set([
    ...spec.assets.map((asset) => asset.id),
    ...spec.pages.flatMap((page) => page.blocks.map((block) => block.id)),
  ]);
}

/** One step down: an own field of a plain object, or an index of an array within its bounds. */
function step(node: unknown, key: string | number, path: Path): unknown {
  if (Array.isArray(node)) {
    if (typeof key !== 'number' || key >= node.length)
      throw new OperationError('invalid_path', `Nothing at ${path.join('.')}.`);
    return node[key];
  }
  if (!isPlainObject(node) || typeof key !== 'string' || !Object.hasOwn(node, key)) {
    throw new OperationError('invalid_path', `Nothing at ${path.join('.')}.`);
  }
  return node[key];
}

/** The container a path ends in (every step before the last must exist) and the last key. */
function locate(root: unknown, path: Path): { parent: Container; key: string | number } {
  let node: unknown = root;
  for (const key of path.slice(0, -1)) node = step(node, key, path);
  if (!Array.isArray(node) && !isPlainObject(node))
    throw new OperationError('invalid_path', `Nothing at ${path.join('.')}.`);
  return { parent: node, key: path.at(-1) as string | number };
}

/** Deep merge; `null` removes a key; arrays are replaced. */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === null) delete out[key];
    else if (isPlainObject(value) && isPlainObject(out[key]))
      out[key] = merge(out[key] as Record<string, unknown>, value);
    else out[key] = value;
  }
  return out;
}

/** Where a page is opened from (actions and rich-text links; the menu is cleaned up with the page). */
function pageUses(spec: SiteSpec, pageId: string): Path[] {
  const uses: Path[] = [];
  for (const { value, path } of walk({ pages: spec.pages, layout: spec.layout })) {
    if (isCta(value) && value.kind === 'page' && value.pageId === pageId) uses.push(path);
    if (isPlainObject(value) && value.type === 'rich_text' && isPlainObject(value.props)) {
      const body = value.props.body;
      if (
        isLocalized(body) &&
        Object.values(body).some((text) => parseRichText(text ?? '').pageIds.includes(pageId))
      ) {
        uses.push(path);
      }
    }
  }
  return uses;
}

/** Where an asset is used (asset fields and asset lists). */
function assetUses(spec: SiteSpec, assetId: string): Path[] {
  const uses: Path[] = [];
  for (const { value, path, key } of walk({ layout: spec.layout, pages: spec.pages })) {
    if (typeof key === 'string' && key.endsWith('AssetId') && value === assetId) uses.push(path);
    if (key === 'assetIds' && Array.isArray(value) && value.includes(assetId)) uses.push(path);
  }
  return uses;
}

/** The asset list a path names (`…assetIds`). */
function assetList(next: SiteSpec, path: Path): string[] {
  const { parent, key } = locate(next, path);
  const list = step(parent, key, path);
  if (key !== 'assetIds' || !Array.isArray(list))
    throw new OperationError('invalid_path', `${path.join('.')} is not an asset list.`);
  return list as string[];
}

function assertAsset(next: SiteSpec, assetId: string) {
  if (!next.assets.some((asset) => asset.id === assetId))
    throw new OperationError('asset_not_found', `There is no asset "${assetId}".`);
}

/** Applies one operation to `next` (a copy it may change); returns the inverse, flat. */
function applyBase(next: SiteSpec, operation: BaseOperation): BaseOperation[] {
  switch (operation.op) {
    case 'addPage': {
      if (next.pages.some((page) => page.id === operation.page.id))
        throw new OperationError('duplicate_id', `Page "${operation.page.id}" exists.`);
      const ids = elementIds(next);
      for (const block of operation.page.blocks) {
        if (ids.has(block.id)) throw new OperationError('duplicate_id', `Id "${block.id}" is taken.`);
        ids.add(block.id);
      }
      next.pages.splice(
        Math.min(operation.index ?? next.pages.length, next.pages.length),
        0,
        copy(operation.page),
      );
      if (!operation.navigation) return [{ op: 'removePage', pageId: operation.page.id }];
      // The menu it replaced comes back with the removal (one inverse operation).
      const before = copy(next.navigation);
      next.navigation = copy(operation.navigation);
      return [{ op: 'removePage', pageId: operation.page.id, navigation: before }];
    }
    case 'removePage': {
      const index = pageIndex(next, operation.pageId);
      // The page's own links (a back-to-top action) go with it.
      const uses = pageUses(next, operation.pageId).filter(
        (path) => !(path[0] === 'pages' && path[1] === index),
      );
      if (uses.length > 0) {
        throw new OperationError(
          'page_in_use',
          `Page "${operation.pageId}" is still opened from ${uses.length} place(s): point them elsewhere first.`,
          uses.map((path) => ({ path, message: 'opens this page' })),
        );
      }
      if (operation.navigation?.items.some((item) => item.pageId === operation.pageId)) {
        throw new OperationError('page_in_use', `The menu given still opens page "${operation.pageId}".`, [
          { path: ['navigation'], message: 'opens this page' },
        ]);
      }
      const [page] = next.pages.splice(index, 1) as [Page];
      const navigation = copy(next.navigation);
      next.navigation = operation.navigation
        ? copy(operation.navigation)
        : {
            ...next.navigation,
            items: next.navigation.items.filter((item) => item.pageId !== operation.pageId),
          };
      // One inverse operation (a batch's inverse is never longer than the batch).
      return [{ op: 'addPage', page, index, navigation }];
    }
    case 'renamePage': {
      const page = next.pages[pageIndex(next, operation.pageId)] as Page;
      const inverse: BaseOperation = {
        op: 'renamePage',
        pageId: page.id,
        title: page.title,
        slug: page.slug,
      };
      page.title = copy(operation.title);
      if (operation.slug !== undefined) page.slug = operation.slug;
      return [inverse];
    }
    case 'reorderPages': {
      const current = next.pages.map((page) => page.id);
      if (
        operation.order.length !== current.length ||
        new Set(operation.order).size !== current.length ||
        !operation.order.every((id) => current.includes(id))
      ) {
        throw new OperationError('invalid_order', 'List every page exactly once.');
      }
      next.pages = operation.order.map((id) => next.pages.find((page) => page.id === id) as Page);
      return [{ op: 'reorderPages', order: current }];
    }
    case 'addBlock': {
      const page = next.pages[pageIndex(next, operation.pageId)] as Page;
      if (elementIds(next).has(operation.block.id))
        throw new OperationError('duplicate_id', `Id "${operation.block.id}" is taken.`);
      page.blocks.splice(
        Math.min(operation.index ?? page.blocks.length, page.blocks.length),
        0,
        copy(operation.block),
      );
      return [{ op: 'removeBlock', pageId: page.id, blockId: operation.block.id }];
    }
    case 'removeBlock': {
      const { page, index, block } = blockAt(next, operation.pageId, operation.blockId);
      page.blocks.splice(index, 1);
      return [{ op: 'addBlock', pageId: page.id, block, index }];
    }
    case 'moveBlock': {
      const { page, index, block } = blockAt(next, operation.pageId, operation.blockId);
      const target = next.pages[pageIndex(next, operation.toPageId ?? operation.pageId)] as Page;
      page.blocks.splice(index, 1);
      target.blocks.splice(Math.min(operation.index, target.blocks.length), 0, block);
      return [{ op: 'moveBlock', pageId: target.id, blockId: block.id, toPageId: page.id, index }];
    }
    case 'updateBlockProps':
    case 'setBlockProps': {
      const { block } = blockAt(next, operation.pageId, operation.blockId);
      const before = copy(block.props) as Record<string, unknown>;
      (block as { props: unknown }).props =
        operation.op === 'setBlockProps' ? copy(operation.props) : merge(before, copy(operation.props));
      return [{ op: 'setBlockProps', pageId: operation.pageId, blockId: block.id, props: before }];
    }
    case 'setBlockVariant': {
      const { block } = blockAt(next, operation.pageId, operation.blockId);
      const before = block.variant;
      (block as { variant: string }).variant = operation.variant;
      return [{ op: 'setBlockVariant', pageId: operation.pageId, blockId: block.id, variant: before }];
    }
    case 'setTheme': {
      const before = next.theme;
      next.theme = copy(operation.theme);
      return [{ op: 'setTheme', theme: before }];
    }
    case 'setContact': {
      const before = next.contact;
      next.contact = copy(operation.contact);
      return [{ op: 'setContact', contact: before }];
    }
    case 'setNavigation': {
      const before = next.navigation;
      next.navigation = copy(operation.navigation);
      return [{ op: 'setNavigation', navigation: before }];
    }
    case 'setLayout': {
      const before = next.layout;
      next.layout = copy(operation.layout);
      return [{ op: 'setLayout', layout: before }];
    }
    case 'setSettings': {
      const before = next.settings;
      next.settings = copy(operation.settings);
      return [{ op: 'setSettings', settings: before }];
    }
    case 'updateText': {
      const { parent, key } = locate(next, operation.path);
      const text = step(parent, key, operation.path);
      if (!isPlainObject(text) || !isLocalized(text))
        throw new OperationError('invalid_path', `${operation.path.join('.')} is not a text.`);
      const before = Object.hasOwn(text, operation.locale) ? (text[operation.locale] as string) : null;
      if (operation.value === null) delete text[operation.locale];
      else text[operation.locale] = operation.value;
      return [{ op: 'updateText', path: operation.path, locale: operation.locale, value: before }];
    }
    case 'addAsset': {
      if (elementIds(next).has(operation.asset.id))
        throw new OperationError('duplicate_id', `Id "${operation.asset.id}" is taken.`);
      next.assets.splice(
        Math.min(operation.index ?? next.assets.length, next.assets.length),
        0,
        copy(operation.asset),
      );
      return [{ op: 'removeAsset', assetId: operation.asset.id }];
    }
    case 'removeAsset': {
      const index = next.assets.findIndex((asset) => asset.id === operation.assetId);
      if (index < 0) throw new OperationError('asset_not_found', `There is no asset "${operation.assetId}".`);
      const uses = assetUses(next, operation.assetId);
      if (uses.length > 0) {
        throw new OperationError(
          'asset_in_use',
          `Asset "${operation.assetId}" is still used.`,
          uses.map((path) => ({ path, message: 'uses this asset' })),
        );
      }
      const [asset] = next.assets.splice(index, 1) as [Asset];
      return [{ op: 'addAsset', asset, index }];
    }
    case 'assignAsset': {
      if (operation.assetId !== null) assertAsset(next, operation.assetId);
      const { parent, key } = locate(next, operation.path);
      if (!isPlainObject(parent) || typeof key !== 'string' || !key.endsWith('AssetId')) {
        throw new OperationError('invalid_path', `${operation.path.join('.')} is not an asset field.`);
      }
      const before =
        Object.hasOwn(parent, key) && typeof parent[key] === 'string' ? (parent[key] as string) : null;
      if (operation.assetId === null) delete parent[key];
      else parent[key] = operation.assetId;
      return [{ op: 'assignAsset', path: operation.path, assetId: before }];
    }
    case 'insertAssetRef': {
      assertAsset(next, operation.assetId);
      const list = assetList(next, operation.path);
      const at = Math.min(operation.index, list.length);
      list.splice(at, 0, operation.assetId);
      return [{ op: 'removeAssetRef', path: operation.path, index: at }];
    }
    case 'removeAssetRef': {
      const list = assetList(next, operation.path);
      if (operation.index >= list.length)
        throw new OperationError(
          'invalid_path',
          `No entry ${operation.index} in ${operation.path.join('.')}.`,
        );
      const [assetId] = list.splice(operation.index, 1) as [string];
      return [{ op: 'insertAssetRef', path: operation.path, index: operation.index, assetId }];
    }
  }
}

/** The parsed spec (what is stored: trimmed texts, defaults), or the schema's problems as an OperationError. */
function checked(spec: SiteSpec): SiteSpec {
  const parsed = SiteSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new OperationError(
      'invalid_result',
      'The change would make the site invalid.',
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

const flat = (inverses: readonly BaseOperation[]): Operation =>
  inverses.length === 1 ? (inverses[0] as BaseOperation) : { op: 'batch', ops: inverses };

/** Applies an operation (a batch: all or nothing); throws `OperationError` and leaves `spec` untouched otherwise. */
export function apply(spec: SiteSpec, operation: Operation): Applied {
  const steps = operation.op === 'batch' ? operation.ops : [operation];
  if (steps.length > MAX_BATCH)
    throw new OperationError('too_many', `At most ${MAX_BATCH} operations at once.`);
  const next = copy(spec);
  const inverses: BaseOperation[] = [];
  try {
    for (const base of steps) inverses.unshift(...applyBase(next, base));
    return {
      spec: checked(next),
      inverse: operation.op === 'batch' ? { op: 'batch', ops: inverses } : flat(inverses),
    };
  } catch (caught) {
    if (caught instanceof OperationError) throw caught;
    throw new OperationError(
      'invalid_result',
      `The change cannot apply: ${caught instanceof Error ? caught.message : String(caught)}.`,
    );
  }
}

/** Applies operations in order, all or nothing (the editor's save). */
export function applyAll(spec: SiteSpec, operations: readonly BaseOperation[]): Applied {
  return apply(spec, { op: 'batch', ops: operations });
}

/**
 * The one entry point for edits from the editor, chat and sitekit: applies, then runs the semantic rules and (with a
 * registry) the facts validator. The caller saves only when there is no error.
 */
export function applyAndValidate(
  spec: SiteSpec,
  operation: Operation,
  options: ValidateOptions & { readonly registry?: FactRegistry },
): Applied & { readonly issues: readonly Issue[] } {
  const applied = apply(spec, operation);
  const issues = [
    ...validateSite(applied.spec, options),
    ...(options.registry ? validateFacts(applied.spec, options.registry) : []),
  ];
  return { ...applied, issues };
}
