import { describe, expect, it } from 'vitest';
import { networkOf } from './site-views.ts';

describe('networkOf', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:0:1:aaaa:bbbb:cccc:dddd', '2001:0db8:0000:0001'],
    // The same /64 written short or in full is one network; two /64s that only differ after `::` are two.
    ['2001:db8::1:2:3:4:5', '2001:0db8:0000:0001'],
    ['2001:db8::2:2:3:4:5', '2001:0db8:0000:0002'],
    ['2001:DB8:0:1::5%eth0', '2001:0db8:0000:0001'],
    ['::1', '0000:0000:0000:0000'],
    ['not an address', ''],
    ['1::2::3', ''],
    [undefined, ''],
  ])('reads %s as %s', (ip, network) => {
    expect(networkOf(ip)).toBe(network);
  });
});
