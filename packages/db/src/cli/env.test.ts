import { describe, expect, it } from 'vitest';
import { flagValues } from './env.ts';

describe('flagValues', () => {
  it('reads space- and equals-separated values, repeated flags', () => {
    expect(flagValues(['--only', 'a', '--only=b,c', '--env', 'dev'], '--only')).toEqual(['a', 'b,c']);
  });

  it('ignores a flag without a value', () => {
    expect(flagValues(['--only'], '--only')).toEqual([]);
  });
});
