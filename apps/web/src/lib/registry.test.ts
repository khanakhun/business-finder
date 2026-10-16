import { describe, expect, it } from 'vitest';
import { createRegistry } from './registry.ts';

describe('createRegistry', () => {
  it('orders entries, replaces by id and unregisters only its own entry', () => {
    const registry = createRegistry<{ id: string; order: number; label?: string }>();
    registry.register({ id: 'b', order: 20 });
    registry.register({ id: 'a', order: 20 });
    const unregisterFirst = registry.register({ id: 'c', order: 10, label: 'first' });
    registry.register({ id: 'c', order: 10, label: 'second' });
    expect(registry.list().map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
    expect(registry.get('c')?.label).toBe('second');
    unregisterFirst(); // replaced already: keeps the newer entry
    expect(registry.get('c')?.label).toBe('second');
    const unregisterD = registry.register({ id: 'd', order: 1 });
    unregisterD();
    expect(registry.get('d')).toBeUndefined();
    registry.reset();
    expect(registry.list()).toEqual([]);
  });
});
