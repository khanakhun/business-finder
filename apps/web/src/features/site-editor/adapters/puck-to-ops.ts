import type { BaseOperation, Block, LocalizedText, SiteSpec } from '@bf/site-schema';
import { type BlockItem, type EditorData, findPage, ITEM_KEYS, type PageRootProps } from './spec-to-puck.ts';

// What the editor's Puck data changed on a page, as BF-033 operations (BF-037): the site is saved through the API's
// operations endpoint (one immutable version, a readable change summary, undo by inverses), never as a replaced
// document. Pure and deterministic: the same data always gives the same operations, and unchanged data gives none.

const ELEMENT_ID = /^[A-Za-z0-9_-]{6,32}$/;

/**
 * The block id of a Puck item. A block's own id is kept; an item Puck created (`hero-<uuid>`, too long for an
 * element id) gets a stable id from it, so every save of the same canvas maps it to the same block.
 */
export function blockIdOf(itemId: string): string {
  if (ELEMENT_ID.test(itemId)) return itemId;
  return `blk${itemId.replace(/[^A-Za-z0-9]/g, '').slice(-24)}`;
}

/** The block a Puck item stands for (undefined props dropped: Puck leaves them for cleared optional fields). */
export function itemToBlock(item: BlockItem): Block {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item.props)) {
    if ((ITEM_KEYS as readonly string[]).includes(key) || value === undefined) continue;
    props[key] = withoutUndefined(value);
  }
  return {
    id: blockIdOf(item.props.id),
    type: item.type,
    variant: item.props.variant,
    props,
  } as Block;
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value))
    if (entry !== undefined) out[key] = withoutUndefined(entry);
  return out;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => deepEqual(entry, b[index]))
    );
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (!deepEqual(a[key], b[key])) return false;
  return true;
}

/**
 * The `updateBlockProps` patch from `before` to `after` (its merge: objects merge, arrays and values replace, `null`
 * removes), or undefined when they are equal.
 */
export function propsPatch(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[key];
    const now = after[key];
    if (deepEqual(was, now)) continue;
    if (now === undefined) patch[key] = null;
    else if (isPlainObject(was) && isPlainObject(now)) patch[key] = propsPatch(was, now);
    else patch[key] = structuredClone(now);
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Per-locale `updateText` operations from `before` to `after` at `path`. */
function textOps(path: (string | number)[], before: LocalizedText, after: LocalizedText): BaseOperation[] {
  const ops: BaseOperation[] = [];
  for (const locale of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof LocalizedText>) {
    const now = after[locale];
    if (before[locale] === now) continue;
    ops.push({ op: 'updateText', path, locale, value: now === undefined || now === '' ? null : now });
  }
  return ops;
}

function rootOps(spec: SiteSpec, pageId: string, root: PageRootProps): BaseOperation[] {
  const page = findPage(spec, pageId);
  const index = spec.pages.indexOf(page);
  const ops: BaseOperation[] = [];
  const titleChanged = !deepEqual(page.title, root.title);
  // A cleared field gives no slug: the page keeps "" (the home page's) rather than an undefined one.
  const slug = root.slug ?? '';
  if (titleChanged || page.slug !== slug) {
    ops.push({
      op: 'renamePage',
      pageId,
      title: structuredClone(root.title),
      ...(page.slug !== slug ? { slug } : {}),
    });
  }
  ops.push(...textOps(['pages', index, 'seo', 'title'], page.seo.title, root.seoTitle));
  ops.push(...textOps(['pages', index, 'seo', 'description'], page.seo.description, root.seoDescription));
  return ops;
}

/**
 * The operations that make the page `pageId` of `spec` what the editor shows: removed blocks, then each position in
 * order (a new block added there, a moved one brought there), then each kept block's variant and props, then the
 * page's title, slug and SEO texts. Applied in this order (the API's batch), they give exactly `data`.
 */
export function applyPuckDataToSpec(spec: SiteSpec, pageId: string, data: EditorData): BaseOperation[] {
  const page = findPage(spec, pageId);
  const target = data.content.map(itemToBlock);
  const targetIds = new Set(target.map((block) => block.id));
  const ops: BaseOperation[] = [];

  const current = page.blocks.map((block) => block.id);
  for (const block of page.blocks) {
    if (targetIds.has(block.id)) continue;
    ops.push({ op: 'removeBlock', pageId, blockId: block.id });
    current.splice(current.indexOf(block.id), 1);
  }

  const before = new Map(page.blocks.map((block) => [block.id, block]));
  target.forEach((block, index) => {
    if (current[index] === block.id) return;
    if (!before.has(block.id)) {
      ops.push({ op: 'addBlock', pageId, block: structuredClone(block), index });
      current.splice(index, 0, block.id);
      return;
    }
    ops.push({ op: 'moveBlock', pageId, blockId: block.id, index });
    current.splice(current.indexOf(block.id), 1);
    current.splice(index, 0, block.id);
  });

  for (const block of target) {
    const was = before.get(block.id);
    if (!was) continue;
    if (was.variant !== block.variant) {
      ops.push({ op: 'setBlockVariant', pageId, blockId: block.id, variant: block.variant });
    }
    const patch = propsPatch(was.props as Record<string, unknown>, block.props as Record<string, unknown>);
    if (patch) ops.push({ op: 'updateBlockProps', pageId, blockId: block.id, props: patch });
  }

  ops.push(...rootOps(spec, pageId, data.root.props));
  return ops;
}
