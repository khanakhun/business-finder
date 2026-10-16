import { applyAll, type BaseOperation, type BlockType, MAX_BATCH, type SiteSpec } from '@bf/site-schema';

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
    const keys = path.slice(5).filter((step): step is string => typeof step === 'string' && step.length > 2);
    const field = path[4] === 'props' ? keys[0] : undefined;
    return field ? `${labels.block(block.type)} › ${labels.field(field)}` : labels.block(block.type);
  }
  const key =
    path[2] === 'seo' ? `seo${String(path[3] ?? '').replace(/^./, (c) => c.toUpperCase())}` : path[2];
  return typeof key === 'string'
    ? `${labels.page} › ${labels.field(key === 'title' ? 'pageTitle' : key)}`
    : labels.page;
}
