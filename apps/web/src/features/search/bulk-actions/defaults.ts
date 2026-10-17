import { registerCrmBulkActions } from '@/features/business/bulk-actions.tsx';
import { registerEnrichmentBulkAction } from '@/features/enrichment/bulk-enrich.tsx';
import { type BulkAction, registerBulkAction } from './registry.ts';

// The bulk actions BF-023 ships. Later tickets register theirs the same way (and replace the placeholders by id).

export const ADD_TO_LIST_DIALOG = 'search.add-to-list';
export const MAX_EXPORT_IDS = 200;
/** A generation batch holds at most 50 items (BF-039). */
export const MAX_SITE_IDS = 50;

const actions: BulkAction[] = [
  {
    id: 'search.add-to-list',
    labelKey: 'search.bulk.addToList',
    icon: 'list-plus',
    permission: 'business:write',
    order: 10,
    run: async (context, ui) => ui.dialog(ADD_TO_LIST_DIALOG, { ids: context.selection.ids }),
  },
  {
    id: 'search.export',
    labelKey: 'search.bulk.export',
    icon: 'download',
    permission: 'business:read',
    order: 20,
    allowEmptySelection: true,
    // A selection is exported by id (≤ 200 keeps the URL short); nothing selected exports every result.
    disabledReason: (context) =>
      context.selection.ids.length > MAX_EXPORT_IDS ? 'search.bulk.tooMany' : null,
    run: async (context, ui) => {
      const { ids, query } = context.selection;
      ui.download('/v1/businesses/export.csv', ids.length > 0 ? { ...query, id: [...ids] } : query);
      return null;
    },
  },
  {
    id: 'sites.create',
    labelKey: 'search.bulk.createSites',
    icon: 'layout-template',
    permission: 'sites:generate',
    order: 50,
    disabledReason: (context) =>
      context.selection.ids.length > MAX_SITE_IDS ? 'search.bulk.tooManySites' : null,
    // The create flow (BF-046) with the selection, in the listing's order.
    run: async (context, ui) => {
      ui.navigate(`/generation/new?ids=${context.selection.ids.join(',')}`);
      return null;
    },
  },
  {
    id: 'outreach.enroll',
    labelKey: 'search.bulk.enroll',
    icon: 'send',
    permission: 'outreach:send',
    order: 60,
    disabledReason: () => 'search.bulk.comingOutreach',
    run: async () => null,
  },
];

let registered = false;

/** Idempotent: the search page calls it once mounted. */
export function registerDefaultBulkActions(): void {
  if (registered) return;
  registered = true;
  for (const action of actions) registerBulkAction(action);
  // Tags and pipeline status (BF-024).
  registerCrmBulkActions();
  // Enrich (BF-027).
  registerEnrichmentBulkAction();
}
