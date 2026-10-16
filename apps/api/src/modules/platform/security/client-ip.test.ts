import { describe, expect, it } from 'vitest';
import { trustedProxyMatcher } from './client-ip.ts';

describe('trustedProxyMatcher', () => {
  const trusted = trustedProxyMatcher(['10.0.0.0/24', '192.0.2.10', 'fd00::/8', '::1']);

  it.each([
    ['10.0.0.7', true],
    ['10.0.1.7', false],
    ['192.0.2.10', true],
    ['192.0.2.11', false],
    ['fd00::1', true],
    ['::1', true],
    ['2001:db8::1', false],
    ['not-an-ip', false],
    ['', false],
  ])('%s → %s', (ip, expected) => {
    expect(trusted(ip)).toBe(expected);
  });

  it('trusts nobody by default', () => {
    expect(trustedProxyMatcher([])('127.0.0.1')).toBe(false);
  });
});
