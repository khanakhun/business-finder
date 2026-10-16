import { InvalidStateTransitionError } from '@bf/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canReserve, settle } from './budget.ts';
import { splitTile, tileKey } from './quadtree.ts';
import { assertTransition, finalOutcome, isTerminal } from './run-state-machine.ts';
import { distanceM } from './tile-geometry.ts';

describe('run state machine', () => {
  it('allows the documented transitions only and freezes terminal states', () => {
    expect(() => assertTransition('queued', 'running')).not.toThrow();
    expect(() => assertTransition('running', 'partially_completed')).not.toThrow();
    expect(() => assertTransition('queued', 'cancelled')).not.toThrow();
    expect(() => assertTransition('completed', 'running')).toThrow(InvalidStateTransitionError);
    expect(() => assertTransition('cancelled', 'running')).toThrow(InvalidStateTransitionError);
    expect(isTerminal('partially_completed')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });

  it('derives the final status from task counts and the stop reason', () => {
    const counts = { tasksTotal: 4, tasksDone: 4, tasksFailed: 0, tasksSkipped: 0 };
    expect(finalOutcome(counts, null)).toEqual({ status: 'completed', reason: null });
    expect(finalOutcome({ ...counts, tasksDone: 3, tasksSkipped: 1 }, 'budget')).toEqual({
      status: 'partially_completed',
      reason: 'budget',
    });
    expect(finalOutcome({ ...counts, tasksDone: 3, tasksFailed: 1 }, null)).toEqual({
      status: 'partially_completed',
      reason: 'tasks_failed',
    });
    expect(finalOutcome({ ...counts, tasksDone: 0, tasksFailed: 4 }, null)).toEqual({
      status: 'failed',
      reason: 'tasks_failed',
    });
    const none = { tasksTotal: 0, tasksDone: 0, tasksFailed: 0, tasksSkipped: 0 };
    expect(finalOutcome(none, null)).toEqual({ status: 'failed', reason: 'no_providers' });
  });
});

describe('budget', () => {
  it('reserves only what fits, including the last call straddling the cap', () => {
    const state = { budgetUsd: 1, costUsd: 0.96, reservedUsd: 0 };
    expect(canReserve(state, 0.032)).toBe(true);
    expect(canReserve({ ...state, reservedUsd: 0.032 }, 0.032)).toBe(false);
    expect(canReserve({ budgetUsd: 0, costUsd: 0, reservedUsd: 0 }, 0)).toBe(true);
  });

  it('never lets cost + reserved exceed the budget over any sequence of reserve/settle', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.double({ min: 0, max: 0.05, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true })),
          { maxLength: 200 },
        ),
        fc.double({ min: 0, max: 2, noNaN: true }),
        (calls, budgetUsd) => {
          let state = { budgetUsd, costUsd: 0, reservedUsd: 0 };
          for (const [estimate, actualShare] of calls) {
            if (!canReserve(state, estimate)) continue;
            state = { ...state, reservedUsd: state.reservedUsd + estimate };
            expect(state.costUsd + state.reservedUsd).toBeLessThanOrEqual(budgetUsd + 1e-6);
            state = settle(state, estimate, estimate * actualShare);
          }
          expect(state.costUsd).toBeLessThanOrEqual(budgetUsd + 1e-6);
          expect(state.reservedUsd).toBeLessThan(1e-6);
        },
      ),
    );
  });
});

describe('quadtree', () => {
  it('splits a circle into four smaller circles covering it', () => {
    const tile = { type: 'Circle' as const, center: { lat: 17.9, lng: -62.85 }, radiusM: 1500 };
    const children = splitTile(tile);
    expect(children).toHaveLength(4);
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (angle, share) => {
          const km = (share * 1500) / 1000;
          const point = {
            lat: tile.center.lat + (km * Math.sin(angle)) / 110.574,
            lng: tile.center.lng + (km * Math.cos(angle)) / (111.32 * Math.cos((17.9 * Math.PI) / 180)),
          };
          const covered = children.some(
            (c) => c.type === 'Circle' && distanceM(point, c.center) <= c.radiusM + 1,
          );
          expect(covered).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('splits boxes into quadrants and stops splitting tiny circles', () => {
    const quads = splitTile({ type: 'BBox', bbox: { west: 0, south: 0, east: 2, north: 2 } });
    expect(quads.map((q) => q.type === 'BBox' && q.bbox)).toEqual([
      { west: 0, south: 0, east: 1, north: 1 },
      { west: 1, south: 0, east: 2, north: 1 },
      { west: 0, south: 1, east: 1, north: 2 },
      { west: 1, south: 1, east: 2, north: 2 },
    ]);
    expect(splitTile({ type: 'Circle', center: { lat: 0, lng: 0 }, radiusM: 150 })).toEqual([]);
    expect(tileKey({ type: 'Circle', center: { lat: 17.9, lng: -62.85 }, radiusM: 1500.4 })).toBe(
      'c:17.9,-62.85,1500',
    );
  });
});
