import { afterEach, describe, expect, it } from 'vitest';
import { type BulkAction, bulkActionsFor, registerBulkAction, resetBulkActions } from './registry.ts';

const action = (overrides: Partial<BulkAction>): BulkAction => ({
  id: 'x',
  labelKey: 'search.bulk.x',
  icon: 'list',
  permission: 'business:write',
  order: 10,
  run: async () => ({ done: 1 }),
  ...overrides,
});

const context = (ids: string[], permissions: string[]) =>
  ({ selection: { ids, query: {} }, permissions: new Set(permissions) }) as Parameters<
    typeof bulkActionsFor
  >[0];

afterEach(resetBulkActions);

describe('bulk action registry', () => {
  it('orders actions and hides those the user may not do', () => {
    registerBulkAction(action({ id: 'b', order: 20 }));
    registerBulkAction(action({ id: 'a', order: 20 }));
    registerBulkAction(
      action({ id: 'export', order: 5, permission: 'business:read', allowEmptySelection: true }),
    );
    const viewer = bulkActionsFor(context(['1'], ['business:read']));
    expect(viewer.map((a) => [a.action.id, a.visible, a.enabled])).toEqual([
      ['export', true, true],
      ['a', false, false],
      ['b', false, false],
    ]);
  });

  it('needs a selection unless the action applies to every result, and honours disabled reasons', () => {
    registerBulkAction(action({ id: 'list' }));
    registerBulkAction(action({ id: 'export', permission: 'business:read', allowEmptySelection: true }));
    registerBulkAction(action({ id: 'status', disabledReason: () => 'search.bulk.needsCrm' }));
    const none = bulkActionsFor(context([], ['business:read', 'business:write']));
    expect(none.find((a) => a.action.id === 'list')).toMatchObject({
      enabled: false,
      reason: 'search.bulk.selectFirst',
    });
    expect(none.find((a) => a.action.id === 'export')).toMatchObject({ enabled: true, reason: null });
    const some = bulkActionsFor(context(['1'], ['business:read', 'business:write']));
    expect(some.find((a) => a.action.id === 'status')).toMatchObject({
      enabled: false,
      reason: 'search.bulk.needsCrm',
    });
  });

  it('replaces by id and unregisters only its own registration', () => {
    const off = registerBulkAction(action({ id: 'x', order: 1 }));
    registerBulkAction(action({ id: 'x', order: 2 }));
    off();
    expect(bulkActionsFor(context(['1'], ['business:write'])).map((a) => a.action.order)).toEqual([2]);
  });
});
