import { describe, expect, it } from 'vitest';
import { describeSystem } from './system-info.ts';

describe('describeSystem', () => {
  it('combines build facts with the given time in UTC ISO-8601', () => {
    const info = describeSystem(
      { name: 'api', version: '1.2.3', commit: 'abc123', env: 'development' },
      new Date('2026-10-14T12:00:00+02:00'),
    );
    expect(info).toEqual({
      name: 'api',
      version: '1.2.3',
      commit: 'abc123',
      env: 'development',
      time: '2026-10-14T10:00:00.000Z',
    });
  });
});
