import { apply, type BaseOperation, type Operation, OperationError, type SiteSpec } from '@bf/site-schema';

// Site-level changes in the editor (BF-037): settings, menu, languages and pages, as BF-033 operations applied to the
// working site and kept for the save. Each change is undone by its inverse (and redone by itself), so the settings'
// history lives here, beside Puck's own history of the canvas. Rebasing replays local operations on a newer version.

/** What the save sends, and what undo and redo walk through. */
export interface SiteChanges {
  readonly working: SiteSpec;
  /** Every operation since the base, in order (the canvas's own edits are folded in on leaving a page). */
  readonly pending: readonly BaseOperation[];
  readonly undo: readonly { readonly op: BaseOperation; readonly inverse: readonly BaseOperation[] }[];
  readonly redo: readonly BaseOperation[];
}

export const flatten = (operation: Operation): BaseOperation[] =>
  operation.op === 'batch' ? [...operation.ops] : [operation];

export const startChanges = (spec: SiteSpec): SiteChanges => ({
  working: spec,
  pending: [],
  undo: [],
  redo: [],
});

/** Applies a site-level change (throws `OperationError` when it cannot apply; nothing changes then). */
export function change(state: SiteChanges, op: BaseOperation): SiteChanges {
  const applied = apply(state.working, op);
  return {
    working: applied.spec,
    pending: [...state.pending, op],
    undo: [...state.undo, { op, inverse: flatten(applied.inverse) }],
    redo: [],
  };
}

/** Undoes the last site-level change (as new operations: the save sends the whole story, never a rewrite). */
export function undo(state: SiteChanges): SiteChanges {
  const last = state.undo.at(-1);
  if (!last) return state;
  const applied = apply(state.working, { op: 'batch', ops: [...last.inverse] });
  return {
    working: applied.spec,
    pending: [...state.pending, ...last.inverse],
    undo: state.undo.slice(0, -1),
    redo: [...state.redo, last.op],
  };
}

export function redo(state: SiteChanges): SiteChanges {
  const next = state.redo.at(-1);
  if (!next) return state;
  const applied = apply(state.working, next);
  return {
    working: applied.spec,
    pending: [...state.pending, next],
    undo: [...state.undo, { op: next, inverse: flatten(applied.inverse) }],
    redo: state.redo.slice(0, -1),
  };
}

/** Local operations replayed on a newer version: those that still apply, and those that no longer do (and why). */
export interface Rebased {
  readonly spec: SiteSpec;
  readonly applied: readonly BaseOperation[];
  readonly failed: readonly { readonly op: BaseOperation; readonly reason: string }[];
}

/**
 * Replays `ops` on `latest`, one at a time, in order: an operation whose target is gone (a block someone deleted, a
 * path that no longer exists) or whose result the schema refuses is set aside with its reason, and the rest go on.
 * Deterministic: the same inputs always give the same result.
 */
export function rebase(latest: SiteSpec, ops: readonly BaseOperation[]): Rebased {
  let spec = latest;
  const applied: BaseOperation[] = [];
  const failed: { op: BaseOperation; reason: string }[] = [];
  for (const op of ops) {
    try {
      spec = apply(spec, op).spec;
      applied.push(op);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      failed.push({ op, reason: error.details[0]?.message ?? error.message });
    }
  }
  return { spec, applied, failed };
}
