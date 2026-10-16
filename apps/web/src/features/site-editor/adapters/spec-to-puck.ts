import type { Block, BlockType, LocalizedText, Page, SiteSpec } from '@bf/site-schema';

// The editor's view of one SiteSpec page as Puck data (BF-037): each block is a Puck item whose id is the block's
// id, with its variant and props side by side; the page's title, slug and SEO are the root's props. Pure: no Puck
// runtime, no React (Puck's `Data` shape is mirrored, so these adapters stay framework-free and unit-tested).

/** A block as a Puck item's props: its id, its variant and its own props, flat (no block prop is named either). */
export type BlockItemProps = { readonly id: string; readonly variant: string } & Readonly<
  Record<string, unknown>
>;

export interface BlockItem {
  readonly type: BlockType;
  readonly props: BlockItemProps;
}

/** The page settings the canvas's root carries. */
export interface PageRootProps {
  readonly title: LocalizedText;
  readonly slug: string;
  readonly seoTitle: LocalizedText;
  readonly seoDescription: LocalizedText;
}

/** Puck's `Data` for one page (`content` and `root`; no zones: SiteSpec pages have one flow of blocks). */
export interface EditorData {
  readonly root: { readonly props: PageRootProps };
  readonly content: readonly BlockItem[];
}

/** Props an item carries besides the block's own. */
export const ITEM_KEYS = ['id', 'variant'] as const;

export function blockToItem(block: Block): BlockItem {
  return {
    type: block.type,
    props: {
      ...structuredClone(block.props as Record<string, unknown>),
      id: block.id,
      variant: block.variant,
    },
  };
}

export function findPage(spec: SiteSpec, pageId: string): Page {
  const page = spec.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`No page "${pageId}" in this site.`);
  return page;
}

/** One page of a spec as the editor's Puck data. */
export function specPageToPuckData(spec: SiteSpec, pageId: string): EditorData {
  const page = findPage(spec, pageId);
  return {
    root: {
      props: {
        title: structuredClone(page.title),
        slug: page.slug,
        seoTitle: structuredClone(page.seo.title),
        seoDescription: structuredClone(page.seo.description),
      },
    },
    content: page.blocks.map(blockToItem),
  };
}
