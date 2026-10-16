import type { Block } from '../spec/blocks/index.ts';
import type { Page } from '../spec/page.ts';
import { type SiteSpec, SiteSpecSchema } from '../spec/site.ts';
import { type BaseOperation, type Operation, OperationError } from './operations.ts';

// Applying operations (BF-033): on a copy, with the operation's own checks, then the schema; the result carries the
// inverse that restores the spec exactly. A batch applies all or nothing; its inverse undoes in reverse order.

export interface Applied {
  readonly spec: SiteSpec;
  readonly inverse: Operation;
}

type Path = readonly (string | number)[];

const copy = <T>(value: T): T => structuredClone(value);

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

/** The container and key a path ends in (every step but the last must exist). */
function locate(
  root: unknown,
  path: Path,
): { parent: Record<string | number, unknown>; key: string | number } {
  let node: unknown = root;
  for (const step of path.slice(0, -1)) {
    if (!node || typeof node !== 'object' || !(step in (node as object))) {
      throw new OperationError('invalid_path', `Nothing at ${path.join('.')}.`);
    }
    node = (node as Record<string | number, unknown>)[step];
  }
  if (!node || typeof node !== 'object')
    throw new OperationError('invalid_path', `Nothing at ${path.join('.')}.`);
  return { parent: node as Record<string | number, unknown>, key: path.at(-1) as string | number };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Deep merge; `null` removes a key; arrays are replaced. */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === null) delete out[key];
    else if (isRecord(value) && isRecord(out[key]))
      out[key] = merge(out[key] as Record<string, unknown>, value);
    else out[key] = value;
  }
  return out;
}

function applyBase(spec: SiteSpec, operation: BaseOperation): Applied {
  const next = copy(spec);
  switch (operation.op) {
    case 'addPage': {
      if (next.pages.some((page) => page.id === operation.page.id))
        throw new OperationError('duplicate_id', `Page "${operation.page.id}" exists.`);
      const ids = elementIds(next);
      for (const block of operation.page.blocks)
        if (ids.has(block.id)) throw new OperationError('duplicate_id', `Id "${block.id}" is taken.`);
      const index = Math.min(operation.index ?? next.pages.length, next.pages.length);
      next.pages.splice(index, 0, copy(operation.page));
      return { spec: next, inverse: { op: 'removePage', pageId: operation.page.id } };
    }
    case 'removePage': {
      const index = pageIndex(next, operation.pageId);
      const [page] = next.pages.splice(index, 1) as [Page];
      const navigation = copy(next.navigation);
      next.navigation.items = next.navigation.items.filter((item) => item.pageId !== operation.pageId);
      return {
        spec: next,
        inverse: {
          op: 'batch',
          ops: [
            { op: 'addPage', page, index },
            { op: 'setNavigation', navigation },
          ],
        },
      };
    }
    case 'renamePage': {
      const page = next.pages[pageIndex(next, operation.pageId)] as Page;
      const inverse: Operation = { op: 'renamePage', pageId: page.id, title: page.title, slug: page.slug };
      page.title = copy(operation.title);
      if (operation.slug !== undefined) page.slug = operation.slug;
      return { spec: next, inverse };
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
      return { spec: next, inverse: { op: 'reorderPages', order: current } };
    }
    case 'addBlock': {
      const page = next.pages[pageIndex(next, operation.pageId)] as Page;
      if (elementIds(next).has(operation.block.id))
        throw new OperationError('duplicate_id', `Id "${operation.block.id}" is taken.`);
      const index = Math.min(operation.index ?? page.blocks.length, page.blocks.length);
      page.blocks.splice(index, 0, copy(operation.block));
      return { spec: next, inverse: { op: 'removeBlock', pageId: page.id, blockId: operation.block.id } };
    }
    case 'removeBlock': {
      const { page, index, block } = blockAt(next, operation.pageId, operation.blockId);
      page.blocks.splice(index, 1);
      return { spec: next, inverse: { op: 'addBlock', pageId: page.id, block, index } };
    }
    case 'moveBlock': {
      const { page, index, block } = blockAt(next, operation.pageId, operation.blockId);
      const target = next.pages[pageIndex(next, operation.toPageId ?? operation.pageId)] as Page;
      page.blocks.splice(index, 1);
      const to = Math.min(operation.index, target.blocks.length);
      target.blocks.splice(to, 0, block);
      return {
        spec: next,
        inverse: { op: 'moveBlock', pageId: target.id, blockId: block.id, toPageId: page.id, index },
      };
    }
    case 'updateBlockProps':
    case 'setBlockProps': {
      const { block } = blockAt(next, operation.pageId, operation.blockId);
      const before = copy(block.props) as Record<string, unknown>;
      (block as { props: unknown }).props =
        operation.op === 'setBlockProps' ? copy(operation.props) : merge(before, copy(operation.props));
      return {
        spec: next,
        inverse: { op: 'setBlockProps', pageId: operation.pageId, blockId: block.id, props: before },
      };
    }
    case 'setBlockVariant': {
      const { block } = blockAt(next, operation.pageId, operation.blockId);
      const before = block.variant;
      (block as { variant: string }).variant = operation.variant;
      return {
        spec: next,
        inverse: { op: 'setBlockVariant', pageId: operation.pageId, blockId: block.id, variant: before },
      };
    }
    case 'setTheme': {
      const before = next.theme;
      next.theme = copy(operation.theme);
      return { spec: next, inverse: { op: 'setTheme', theme: before } };
    }
    case 'setContact': {
      const before = next.contact;
      next.contact = copy(operation.contact);
      return { spec: next, inverse: { op: 'setContact', contact: before } };
    }
    case 'setNavigation': {
      const before = next.navigation;
      next.navigation = copy(operation.navigation);
      return { spec: next, inverse: { op: 'setNavigation', navigation: before } };
    }
    case 'updateText': {
      const { parent, key } = locate(next, operation.path);
      const text = parent[key];
      if (!isRecord(text))
        throw new OperationError('invalid_path', `${operation.path.join('.')} is not a text.`);
      const before = typeof text[operation.locale] === 'string' ? (text[operation.locale] as string) : null;
      if (operation.value === null) delete text[operation.locale];
      else text[operation.locale] = operation.value;
      return {
        spec: next,
        inverse: { op: 'updateText', path: operation.path, locale: operation.locale, value: before },
      };
    }
    case 'addAsset': {
      if (elementIds(next).has(operation.asset.id))
        throw new OperationError('duplicate_id', `Id "${operation.asset.id}" is taken.`);
      next.assets.splice(
        Math.min(operation.index ?? next.assets.length, next.assets.length),
        0,
        copy(operation.asset),
      );
      return { spec: next, inverse: { op: 'removeAsset', assetId: operation.asset.id } };
    }
    case 'removeAsset': {
      const index = next.assets.findIndex((asset) => asset.id === operation.assetId);
      if (index < 0) throw new OperationError('asset_not_found', `There is no asset "${operation.assetId}".`);
      const used = JSON.stringify({ ...next, assets: [] }).includes(`"${operation.assetId}"`);
      if (used) throw new OperationError('asset_in_use', `Asset "${operation.assetId}" is still used.`);
      const [asset] = next.assets.splice(index, 1) as [SiteSpec['assets'][number]];
      return { spec: next, inverse: { op: 'addAsset', asset, index } };
    }
    case 'assignAsset': {
      if (operation.assetId !== null && !next.assets.some((asset) => asset.id === operation.assetId)) {
        throw new OperationError('asset_not_found', `There is no asset "${operation.assetId}".`);
      }
      const { parent, key } = locate(next, operation.path);
      const field = String(key);
      const inList = Array.isArray(parent) && operation.path.at(-2) === 'assetIds';
      if (!inList && !field.endsWith('AssetId'))
        throw new OperationError('invalid_path', `${operation.path.join('.')} is not an asset field.`);
      const before = typeof parent[key] === 'string' ? (parent[key] as string) : null;
      if (operation.assetId === null) {
        if (inList) (parent as unknown as unknown[]).splice(Number(key), 1);
        else delete parent[key];
      } else parent[key] = operation.assetId;
      return { spec: next, inverse: { op: 'assignAsset', path: operation.path, assetId: before } };
    }
  }
}

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
  return spec;
}

/** Applies one operation (a batch: all or nothing); throws `OperationError` and leaves `spec` untouched otherwise. */
export function apply(spec: SiteSpec, operation: Operation): Applied {
  if (operation.op === 'batch') {
    let current = spec;
    const inverses: Operation[] = [];
    for (const step of operation.ops) {
      const applied = apply(current, step);
      current = applied.spec;
      inverses.unshift(applied.inverse);
    }
    return { spec: current, inverse: { op: 'batch', ops: inverses } };
  }
  const applied = applyBase(spec, operation);
  return { spec: checked(applied.spec), inverse: applied.inverse };
}

/** Applies operations in order, all or nothing (Unit of work for the editor's save). */
export function applyAll(spec: SiteSpec, operations: readonly Operation[]): Applied {
  return apply(spec, { op: 'batch', ops: operations });
}
