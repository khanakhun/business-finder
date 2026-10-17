import type { ProposalStatus } from '@bf/contracts';
import type { SpecDiff } from '@bf/site-schema/diff';

// What an edit proposal may be (BF-047, Specification): at most 40 operations, and a change to more than half the
// site's blocks only when the user asked for the whole site; plus the proposal lifecycle. Pure.

export const MAX_OPERATIONS = 40;
/** Above this share of blocks touched, the user must have asked for the whole site. */
export const WHOLE_SITE_SHARE = 0.5;

const WHOLE_SITE = [
  /\b(redo|rewrite|redesign|change)\b.{0,20}\b(whole|entire|all of the)\b.{0,10}\bsite\b/i,
  /\b(whole|entire)\s+(web)?site\b/i,
  /\b(refai(s|re|tes)|refonte|réécri(s|re|vez)|change[rz]?)\b.{0,20}\btout\b.{0,10}\b(le\s+)?site\b/i,
  /\btout\s+le\s+site\b/i,
];

/** The user's words ask for the whole site to change. */
export function asksForWholeSite(message: string): boolean {
  return WHOLE_SITE.some((pattern) => pattern.test(message));
}

/** Blocks a diff touches (added, removed, moved or changed, each once). */
export function touchedBlocks(diff: Pick<SpecDiff, 'blocks'>): number {
  const ids = new Set<string>();
  for (const list of [diff.blocks.added, diff.blocks.removed, diff.blocks.moved, diff.blocks.changed])
    for (const block of list) ids.add(`${block.pageId}/${block.blockId}`);
  return ids.size;
}

export type PolicyRefusal =
  | { readonly code: 'TOO_MANY_OPERATIONS'; readonly limit: number }
  | { readonly code: 'WHOLE_SITE_NOT_ASKED'; readonly touched: number; readonly total: number }
  | { readonly code: 'NO_CHANGE' };

/** Why a proposal is refused by policy (null: it may be offered). */
export function policyRefusal(input: {
  readonly operations: number;
  readonly diff: Pick<SpecDiff, 'blocks' | 'texts' | 'sections' | 'pages'>;
  readonly totalBlocks: number;
  readonly userMessage: string;
}): PolicyRefusal | null {
  if (input.operations > MAX_OPERATIONS) return { code: 'TOO_MANY_OPERATIONS', limit: MAX_OPERATIONS };
  const touched = touchedBlocks(input.diff);
  const unchanged =
    touched === 0 &&
    input.diff.texts.length === 0 &&
    input.diff.sections.length === 0 &&
    input.diff.pages.added.length === 0 &&
    input.diff.pages.removed.length === 0;
  if (unchanged) return { code: 'NO_CHANGE' };
  if (
    input.totalBlocks > 0 &&
    touched / input.totalBlocks > WHOLE_SITE_SHARE &&
    !asksForWholeSite(input.userMessage)
  )
    return { code: 'WHOLE_SITE_NOT_ASKED', touched, total: input.totalBlocks };
  return null;
}

/** Statuses a proposal can still leave. */
const OPEN: ReadonlySet<ProposalStatus> = new Set(['proposed']);

export function isOpen(status: ProposalStatus): boolean {
  return OPEN.has(status);
}
