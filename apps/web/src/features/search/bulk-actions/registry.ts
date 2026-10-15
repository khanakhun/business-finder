import type { Permission } from '@bf/contracts';
import type * as React from 'react';

// Bulk actions on selected search results (BF-023). The page renders whatever is registered, so later tickets add
// actions (create sites, enroll in a sequence…) by registering them — never by editing the page.

export interface BulkSelection {
  /** Selected business ids (empty when the action applies to every result, e.g. export all). */
  readonly ids: readonly string[];
  /** The listing filters and sort, in API query form (for "all results" actions). */
  readonly query: Readonly<Record<string, string | string[]>>;
}

export interface BulkActionContext {
  readonly selection: BulkSelection;
  readonly permissions: ReadonlySet<Permission>;
}

/** What happened, for the toast: how many succeeded, which failed and why. */
export interface BulkActionResult {
  readonly done: number;
  readonly failed?: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
}

export interface BulkAction {
  readonly id: string;
  /** `search.bulk.*` message key of the button label. */
  readonly labelKey: string;
  /** Lucide icon name (resolved by the bar). */
  readonly icon: string;
  readonly permission: Permission;
  /** Lower first. */
  readonly order: number;
  /** Also offered with nothing selected (applies to every result). */
  readonly allowEmptySelection?: boolean;
  /** A message key explaining why the action is not available yet (shown as a tooltip), or null. */
  disabledReason?(context: BulkActionContext): string | null;
  /**
   * Runs the action. Actions that need input (a list to pick, tags to type) open their own dialog through
   * `prompt`, which the bar provides.
   */
  run(context: BulkActionContext, ui: BulkActionUi): Promise<BulkActionResult | null>;
}

export interface BulkActionUi {
  /** Opens the action's dialog (registered by the action's id) and resolves with its result, or null if cancelled. */
  dialog<T>(id: string, props?: Record<string, unknown>): Promise<T | null>;
  /** Starts a file download from an API path with query parameters. */
  download(path: string, query: Readonly<Record<string, string | string[]>>): void;
}

const registry = new Map<string, BulkAction>();

/** Registers (or replaces, by id) an action; returns an unregister function. */
export function registerBulkAction(action: BulkAction): () => void {
  registry.set(action.id, action);
  return () => {
    if (registry.get(action.id) === action) registry.delete(action.id);
  };
}

export interface BulkActionAvailability {
  readonly action: BulkAction;
  /** Rendered at all (the user may do it at some point). */
  readonly visible: boolean;
  readonly enabled: boolean;
  /** Message key for the tooltip when disabled. */
  readonly reason: string | null;
}

/** Every registered action, ordered, with whether it is usable for this selection and user. */
export function bulkActionsFor(context: BulkActionContext): BulkActionAvailability[] {
  return [...registry.values()]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((action) => {
      if (!context.permissions.has(action.permission)) {
        return { action, visible: false, enabled: false, reason: 'search.bulk.forbidden' };
      }
      if (context.selection.ids.length === 0 && !action.allowEmptySelection) {
        return { action, visible: true, enabled: false, reason: 'search.bulk.selectFirst' };
      }
      const reason = action.disabledReason?.(context) ?? null;
      return { action, visible: true, enabled: reason === null, reason };
    });
}

/** A dialog an action opens through `ui.dialog(id, props)`; it resolves the action with `onClose(result)`. */
export type BulkDialog = React.ComponentType<{
  readonly props: Record<string, unknown>;
  readonly onClose: (result: unknown) => void;
}>;

const dialogs = new Map<string, BulkDialog>();

/** Registers (or replaces) the dialog rendered for `ui.dialog(id)`. */
export function registerBulkDialog(id: string, dialog: BulkDialog): () => void {
  dialogs.set(id, dialog);
  return () => {
    if (dialogs.get(id) === dialog) dialogs.delete(id);
  };
}

export function bulkDialog(id: string): BulkDialog | undefined {
  return dialogs.get(id);
}

/** Test helper: forget every registration. */
export function resetBulkActions(): void {
  registry.clear();
  dialogs.clear();
}
