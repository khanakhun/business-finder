import {
  apply,
  type BaseOperation,
  MAX_BATCH,
  type Operation,
  OperationError,
  type SiteSpec,
} from '@bf/site-schema';
import { deepEqual } from '../adapters/puck-to-ops.ts';

// Site-level changes in the editor (BF-037): settings, menu, languages and pages, as BF-033 operations applied to the
// working site and kept for the save. Each change is undone by its inverse (and redone by itself), so the settings'
// history lives here, beside Puck's own history of the canvas. Rebasing replays local operations on a newer version.

/** What the save sends, and what undo and redo walk through. */
export interface SiteChanges {
  readonly working: SiteSpec;
  /** Every operation since the base, in order, flat (the canvas's own edits are folded in on leaving a page). */
  readonly pending: readonly BaseOperation[];
  readonly undo: readonly {
    readonly ops: readonly BaseOperation[];
    readonly inverse: readonly BaseOperation[];
  }[];
  readonly redo: readonly (readonly BaseOperation[])[];
}

export const flatten = (operation: Operation): BaseOperation[] =>
  operation.op === 'batch' ? [...operation.ops] : [operation];

export const startChanges = (spec: SiteSpec): SiteChanges => ({
  working: spec,
  pending: [],
  undo: [],
  redo: [],
});

/**
 * `ops` applied in batches of at most `MAX_BATCH` (an inverse can be longer: removing a language restores each of its
 * texts), with their inverse in undo order.
 */
function applyMany(
  spec: SiteSpec,
  ops: readonly BaseOperation[],
): { spec: SiteSpec; inverse: BaseOperation[] } {
  let site = spec;
  let inverse: BaseOperation[] = [];
  for (let start = 0; start < ops.length; start += MAX_BATCH) {
    const applied = apply(site, { op: 'batch', ops: ops.slice(start, start + MAX_BATCH) });
    site = applied.spec;
    inverse = [...flatten(applied.inverse), ...inverse];
  }
  return { spec: site, inverse };
}

/** Applies a site-level change (throws `OperationError` when it cannot apply; nothing changes then). */
export function change(state: SiteChanges, op: Operation): SiteChanges {
  const ops = flatten(op);
  const applied = applyMany(state.working, ops);
  return {
    working: applied.spec,
    pending: [...state.pending, ...ops],
    undo: [...state.undo, { ops, inverse: applied.inverse }],
    redo: [],
  };
}

/** Undoes the last site-level change (as new operations: the save sends the whole story, never a rewrite). */
export function undo(state: SiteChanges): SiteChanges {
  const last = state.undo.at(-1);
  if (!last) return state;
  const applied = applyMany(state.working, last.inverse);
  return {
    working: applied.spec,
    pending: [...state.pending, ...last.inverse],
    undo: state.undo.slice(0, -1),
    redo: [...state.redo, last.ops],
  };
}

export function redo(state: SiteChanges): SiteChanges {
  const next = state.redo.at(-1);
  if (!next) return state;
  const applied = applyMany(state.working, next);
  return {
    working: applied.spec,
    pending: [...state.pending, ...next],
    undo: [...state.undo, { ops: next, inverse: applied.inverse }],
    redo: state.redo.slice(0, -1),
  };
}

/** Local operations replayed on a newer version: those that still apply, and those that no longer do (and why). */
export interface Rebased {
  readonly spec: SiteSpec;
  readonly applied: readonly BaseOperation[];
  readonly failed: readonly { readonly op: BaseOperation; readonly reason: string }[];
}

/** Operations that replace a whole section of the site: replaying one would undo whatever someone else changed there. */
const SECTION: Partial<Record<BaseOperation['op'], (spec: SiteSpec) => unknown>> = {
  setTheme: (spec) => spec.theme,
  setContact: (spec) => spec.contact,
  setNavigation: (spec) => spec.navigation,
  setLayout: (spec) => spec.layout,
  setSettings: (spec) => spec.settings,
  setLocales: (spec) => [spec.locales, spec.defaultLocale],
};

const PATH_OPS = new Set<BaseOperation['op']>([
  'updateText',
  'assignAsset',
  'insertAssetRef',
  'removeAssetRef',
]);

/**
 * Replays `ops` (made from `localBase`) on `latest`, one at a time, in order. An operation is set aside, with its reason,
 * when its target is gone (a block or page someone deleted), when the schema refuses its result, or when it replaces a
 * section someone else changed meanwhile. Paths into pages follow the page (by id), wherever it is now.
 * Deterministic: the same inputs always give the same result.
 */
export function rebase(latest: SiteSpec, ops: readonly BaseOperation[], localBase?: SiteSpec): Rebased {
  let spec = latest;
  let local = localBase;
  const applied: BaseOperation[] = [];
  const failed: { op: BaseOperation; reason: string }[] = [];
  for (const op of ops) {
    let replayed: BaseOperation = op;
    try {
      const section = SECTION[op.op];
      if (local && section && !deepEqual(section(local), section(latest))) {
        throw new OperationError('invalid_result', 'Someone else changed this part of the site meanwhile.');
      }
      if (
        local &&
        PATH_OPS.has(op.op) &&
        'path' in op &&
        op.path[0] === 'pages' &&
        typeof op.path[1] === 'number'
      ) {
        const pageId = local.pages[op.path[1]]?.id;
        const index = spec.pages.findIndex((page) => page.id === pageId);
        if (index < 0) throw new OperationError('page_not_found', 'The page was deleted meanwhile.');
        replayed = { ...op, path: ['pages', index, ...op.path.slice(2)] } as BaseOperation;
      }
      spec = apply(spec, replayed).spec;
      applied.push(replayed);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      failed.push({ op, reason: error.details[0]?.message ?? error.message });
    }
    // The local site as it was when the next operation was made (its paths are relative to it).
    if (local) {
      try {
        local = apply(local, op).spec;
      } catch {
        // Never refused locally (it was applied there); kept as is if it somehow is.
      }
    }
  }
  return { spec, applied, failed };
}
