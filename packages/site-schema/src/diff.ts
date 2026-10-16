import type { Block } from './spec/blocks/index.ts';
import { SITE_LOCALES } from './spec/localized.ts';
import type { SiteSpec } from './spec/site.ts';

// What changed between two versions of a site (BF-035), for people: pages and blocks added, removed, moved and
// changed, the texts edited (per locale, with short excerpts) and the site-wide sections touched. Blocks are matched
// by id, so moving a block is a move, not a removal and an addition.

export type Path = readonly (string | number)[];

export interface BlockRef {
  readonly pageId: string;
  readonly blockId: string;
  readonly type: string;
}

export interface SpecDiff {
  readonly summary: string;
  readonly pages: { readonly added: string[]; readonly removed: string[] };
  readonly blocks: {
    readonly added: BlockRef[];
    readonly removed: BlockRef[];
    readonly moved: (BlockRef & { fromPageId: string; fromIndex: number; toIndex: number })[];
    readonly changed: (BlockRef & { fields: string[] })[];
  };
  readonly texts: { path: Path; locale: string; before: string | null; after: string | null }[];
  readonly sections: string[];
}

/** Excerpts are short: enough to recognise the text. */
const EXCERPT = 120;
/** A diff lists at most this many text changes (the summary still counts them all). */
const MAX_TEXTS = 200;
const SECTIONS = [
  'brand',
  'theme',
  'contact',
  'layout',
  'navigation',
  'seo',
  'settings',
  'assets',
  'locales',
] as const;
const LOCALES: ReadonlySet<string> = new Set(SITE_LOCALES);

const excerpt = (text: string | undefined) =>
  text === undefined ? null : text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1)}…` : text;

/** JSON with sorted keys: stored specs come back from jsonb with their keys reordered. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

const isLocalized = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.entries(value).every(([key, text]) => LOCALES.has(key) && typeof text === 'string');

/** Every localized text under a value, by its path (prefixed). */
function texts(value: unknown, path: Path, out: Map<string, { path: Path; text: Record<string, string> }>) {
  if (isLocalized(value)) {
    out.set(JSON.stringify(path), { path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) texts(item, [...path, i], out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) texts(item, [...path, key], out);
  }
}

/** The site's texts keyed so moves do not show as edits: blocks by id, pages by id, the rest by path. */
function siteTexts(spec: SiteSpec) {
  const out = new Map<string, { path: Path; text: Record<string, string> }>();
  for (const page of spec.pages) {
    texts(page.title, ['pages', page.id, 'title'], out);
    texts(page.seo, ['pages', page.id, 'seo'], out);
    for (const block of page.blocks) texts(block.props, ['blocks', block.id], out);
  }
  for (const section of ['seo', 'layout', 'navigation', 'contact', 'assets'] as const)
    texts(spec[section], [section], out);
  return out;
}

function blocksOf(spec: SiteSpec) {
  const out = new Map<string, { pageId: string; index: number; block: Block }>();
  for (const page of spec.pages)
    for (const [index, block] of page.blocks.entries()) out.set(block.id, { pageId: page.id, index, block });
  return out;
}

/** The ids not in the longest run kept in order (what moved, as few as possible). */
function movedWithin(before: readonly string[], after: readonly string[]): Set<string> {
  const position = new Map(before.map((id, i) => [id, i]));
  const sequence = after.map((id) => position.get(id) ?? -1);
  // Longest increasing subsequence (patience sorting), then everything outside it moved.
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const previous: number[] = new Array(sequence.length).fill(-1);
  for (const [i, value] of sequence.entries()) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((tails[mid] as number) < value) low = mid + 1;
      else high = mid;
    }
    tails[low] = value;
    tailIndex[low] = i;
    previous[i] = low > 0 ? (tailIndex[low - 1] as number) : -1;
  }
  const kept = new Set<string>();
  for (let i = tailIndex[tails.length - 1] ?? -1; i >= 0; i = previous[i] as number)
    kept.add(after[i] as string);
  return new Set(after.filter((id) => !kept.has(id)));
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The structural difference between two versions' specs. */
export function diffSpecs(from: SiteSpec, to: SiteSpec): SpecDiff {
  const fromPages = new Set(from.pages.map((page) => page.id));
  const toPages = new Set(to.pages.map((page) => page.id));
  const pages = {
    added: [...toPages].filter((id) => !fromPages.has(id)),
    removed: [...fromPages].filter((id) => !toPages.has(id)),
  };

  const before = blocksOf(from);
  const after = blocksOf(to);
  const ref = (pageId: string, block: Block): BlockRef => ({ pageId, blockId: block.id, type: block.type });
  const added = [...after].filter(([id]) => !before.has(id)).map(([, b]) => ref(b.pageId, b.block));
  const removed = [...before].filter(([id]) => !after.has(id)).map(([, b]) => ref(b.pageId, b.block));

  // A block moved when it changed page, or left the longest run of blocks kept in order on its page.
  const moved: SpecDiff['blocks']['moved'] = [];
  for (const page of to.pages) {
    const common = page.blocks.map((block) => block.id).filter((id) => before.get(id)?.pageId === page.id);
    const order = [...before.values()]
      .filter((b) => b.pageId === page.id && common.includes(b.block.id))
      .sort((a, b) => a.index - b.index)
      .map((b) => b.block.id);
    const reordered = movedWithin(order, common);
    for (const [index, block] of page.blocks.entries()) {
      const was = before.get(block.id);
      if (was && (was.pageId !== page.id || reordered.has(block.id)))
        moved.push({ ...ref(page.id, block), fromPageId: was.pageId, fromIndex: was.index, toIndex: index });
    }
  }

  const changed: SpecDiff['blocks']['changed'] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) continue;
    const fields: string[] = [];
    if (was.block.variant !== now.block.variant) fields.push('variant');
    const props = new Set([
      ...Object.keys(was.block.props as object),
      ...Object.keys(now.block.props as object),
    ]);
    for (const key of props) {
      const a = (was.block.props as Record<string, unknown>)[key];
      const b = (now.block.props as Record<string, unknown>)[key];
      if (!same(a, b)) fields.push(key);
    }
    if (fields.length > 0) changed.push({ ...ref(now.pageId, now.block), fields });
  }

  const textsBefore = siteTexts(from);
  const textsAfter = siteTexts(to);
  // Texts of a block or page added or removed belong to that change, not to the edits.
  const whole = new Set([
    ...added.map((block) => `blocks:${block.blockId}`),
    ...removed.map((block) => `blocks:${block.blockId}`),
    ...pages.added.map((id) => `pages:${id}`),
    ...pages.removed.map((id) => `pages:${id}`),
  ]);
  const edits: SpecDiff['texts'] = [];
  for (const key of new Set([...textsBefore.keys(), ...textsAfter.keys()])) {
    const a = textsBefore.get(key);
    const b = textsAfter.get(key);
    const [kind, id] = (a ?? b)?.path ?? [];
    if (whole.has(`${String(kind)}:${String(id)}`)) continue;
    const path = (b ?? a)?.path ?? [];
    for (const locale of new Set([...Object.keys(a?.text ?? {}), ...Object.keys(b?.text ?? {})])) {
      const textA = a?.text[locale];
      const textB = b?.text[locale];
      if (textA !== textB) edits.push({ path, locale, before: excerpt(textA), after: excerpt(textB) });
    }
  }

  const sections = SECTIONS.filter((section) =>
    section === 'locales'
      ? !same([from.locales, from.defaultLocale], [to.locales, to.defaultLocale])
      : !same(from[section], to[section]),
  );

  const parts = [
    pages.added.length ? `${plural(pages.added.length, 'page')} added` : '',
    pages.removed.length ? `${plural(pages.removed.length, 'page')} removed` : '',
    added.length ? `${plural(added.length, 'block')} added` : '',
    removed.length ? `${plural(removed.length, 'block')} removed` : '',
    moved.length ? `${plural(moved.length, 'block')} moved` : '',
    changed.length ? `${plural(changed.length, 'block')} changed` : '',
    edits.length ? `${plural(edits.length, 'text')} edited` : '',
    sections.length ? `${sections.join(', ')} updated` : '',
  ].filter(Boolean);

  return {
    summary: parts.length > 0 ? parts.join(', ') : 'No change',
    pages,
    blocks: { added, removed, moved, changed },
    texts: edits.slice(0, MAX_TEXTS),
    sections: [...sections],
  };
}
