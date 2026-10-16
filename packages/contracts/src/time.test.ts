import { describe, expect, it } from 'vitest';
import { RealtimeEventSchema } from './realtime.ts';
import { fixedClock, IsoDateTimeSchema, systemClock } from './time.ts';

describe('clocks', () => {
  it('systemClock returns the current time', () => {
    const before = Date.now();
    expect(systemClock.now().getTime()).toBeGreaterThanOrEqual(before);
  });

  it('fixedClock is controllable and returns copies', () => {
    const clock = fixedClock('2026-10-14T00:00:00Z');
    const first = clock.now();
    first.setFullYear(2000);
    expect(clock.now().toISOString()).toBe('2026-10-14T00:00:00.000Z');
    clock.advance(1_500);
    expect(clock.now().toISOString()).toBe('2026-10-14T00:00:01.500Z');
    clock.set(new Date('2027-01-01T00:00:00Z'));
    expect(clock.now().getUTCFullYear()).toBe(2027);
  });
});

describe('IsoDateTimeSchema', () => {
  it('accepts UTC timestamps only', () => {
    expect(IsoDateTimeSchema.safeParse('2026-10-14T10:00:00Z').success).toBe(true);
    expect(IsoDateTimeSchema.safeParse('2026-10-14T10:00:00.123Z').success).toBe(true);
    expect(IsoDateTimeSchema.safeParse('2026-10-14T10:00:00+02:00').success).toBe(false);
    expect(IsoDateTimeSchema.safeParse('2026-10-14').success).toBe(false);
  });
});

describe('RealtimeEventSchema', () => {
  it('validates the base event shape', () => {
    const event = {
      id: '0192f3e4-5b6c-7d8e-9f01-23456789abcd',
      type: 'site.published',
      entity: 'site',
      entityId: 's1',
      orgId: '0192f3e4-5b6c-7d8e-9f01-23456789abce',
      payload: { slug: 'cafe' },
      at: '2026-10-14T10:00:00Z',
    };
    expect(RealtimeEventSchema.parse(event)).toEqual(event);
    expect(RealtimeEventSchema.safeParse({ ...event, orgId: 'x' }).success).toBe(false);
  });
});
