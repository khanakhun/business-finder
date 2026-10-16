import { describe, expect, it } from 'vitest';
import { dayOf, firstDayOf, hourOf } from './views.ts';

describe('view periods', () => {
  it('cuts moments into UTC days and hours', () => {
    const at = new Date('2026-10-14T23:59:59.999Z');
    expect(dayOf(at)).toBe('2026-10-14');
    expect(hourOf(at)).toBe('2026-10-14T23:00:00.000Z');
    expect(dayOf(new Date('2026-10-15T00:00:00.000Z'))).toBe('2026-10-15');
  });

  it('gives the first day of a window ending today', () => {
    expect(firstDayOf(new Date('2026-10-14T12:00:00Z'), 7)).toBe('2026-10-08');
    expect(firstDayOf(new Date('2026-03-01T00:00:00Z'), 30)).toBe('2026-01-31');
    expect(firstDayOf(new Date('2026-10-14T12:00:00Z'), 1)).toBe('2026-10-14');
  });
});
