import {
  applyAll,
  type BaseOperation,
  type Block,
  type BlockType,
  MAX_BATCH,
  type SiteSpec,
} from '@bf/site-schema';
import { itemToBlock } from '../adapters/puck-to-ops.ts';
import type { EditorData } from '../adapters/spec-to-puck.ts';

// The editor session's pure parts (BF-037): applying any number of edits, and naming the field a refusal is about.

/** `ops` applied in order, a batch at a time (one batch holds at most `MAX_BATCH`): the site they make. */
export function applyInBatches(spec: SiteSpec, ops: readonly BaseOperation[]): SiteSpec {
  let site = spec;
  for (let start = 0; start < ops.length; start += MAX_BATCH) {
    site = applyAll(site, ops.slice(start, start + MAX_BATCH)).spec;
  }
  return site;
}

export interface PathLabels {
  readonly block: (type: BlockType) => string;
  readonly field: (key: string) => string;
  readonly page: string;
}

/**
 * Where a validation path points, in the editor's words: "Hero › Title", "Page › Search title". Undefined when the
 * path is not about a page (the site's settings).
 */
export function whereOf(
  spec: SiteSpec,
  path: readonly (string | number)[],
  labels: PathLabels,
): string | undefined {
  if (path[0] !== 'pages' || typeof path[1] !== 'number') return undefined;
  const page = spec.pages[path[1]];
  if (!page) return undefined;
  if (path[2] === 'blocks' && typeof path[3] === 'number') {
    const block = page.blocks[path[3]];
    if (!block) return undefined;
    // ['pages', i, 'blocks', j, 'props', <prop>, …]: the prop is the field.
    const field = path[4] === 'props' && typeof path[5] === 'string' ? path[5] : undefined;
    return field ? `${labels.block(block.type)} › ${labels.field(field)}` : labels.block(block.type);
  }
  const key =
    path[2] === 'seo' ? `seo${String(path[3] ?? '').replace(/^./, (c) => c.toUpperCase())}` : path[2];
  return typeof key === 'string'
    ? `${labels.page} › ${labels.field(key === 'title' ? 'pageTitle' : key)}`
    : labels.page;
}

/**
 * The site with one page's blocks as the canvas has them, unchecked: refusal paths point into the edited site (after
 * the operations), so they are named against it, not against the site before them.
 */
// DECISION(BF-037): past one batch (200 operations on a page) a refusal from an earlier batch points into the order at
// that point, not the final one: the name may then be off by the blocks moved later. Rare enough to accept.
export function withPageBlocks(spec: SiteSpec, pageId: string, blocks: readonly Block[]): SiteSpec {
  return {
    ...spec,
    pages: spec.pages.map((page) => (page.id === pageId ? { ...page, blocks: [...blocks] } : page)),
  };
}

/**
 * The site as the canvas shows it, unchecked (what the validators look at while the person edits): the working site
 * with the page on screen's blocks and settings (title, address, search texts) as the canvas has them.
 */
export function canvasSite(spec: SiteSpec, pageId: string, data: EditorData): SiteSpec {
  const root = data.root.props;
  return {
    ...spec,
    pages: spec.pages.map((page) =>
      page.id === pageId
        ? {
            ...page,
            title: root.title,
            slug: root.slug ?? '',
            seo: { ...page.seo, title: root.seoTitle, description: root.seoDescription },
            blocks: data.content.map(itemToBlock),
          }
        : page,
    ),
  };
}
