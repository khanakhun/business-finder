import { fixedClock } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { GetSystemInfoQuery } from './get-system-info.query.ts';
import type { BuildInfoProvider } from './ports.ts';

// Use cases are plain classes: unit-test them with fakes for their ports, no Nest container needed.
describe('GetSystemInfoQuery', () => {
  it('reports build info at the clock time', () => {
    const buildInfo: BuildInfoProvider = {
      get: () => ({ name: 'api', version: '9.9.9', commit: null, env: 'test' }),
    };
    const query = new GetSystemInfoQuery(buildInfo, fixedClock('2026-01-01T00:00:00Z'));
    expect(query.execute()).toEqual({
      name: 'api',
      version: '9.9.9',
      commit: null,
      env: 'test',
      time: '2026-01-01T00:00:00.000Z',
    });
  });
});
