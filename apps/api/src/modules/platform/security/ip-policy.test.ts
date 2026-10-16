import { describe, expect, it } from 'vitest';
import { isPublicAddress } from './ip-policy.ts';

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8',
    '142.250.27.26',
    '2a00:1450:400c:c06::1a',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('%s is public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.30.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.100.100.200',
    '100.64.0.1',
    '0.0.0.0',
    '192.0.2.10',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254',
    'fc00::1',
    'ff02::1',
    '2001:db8::1',
    '2001:0:4136:e378::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2002:a00:1::1',
    'not an ip',
    '',
  ])('%s is not', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});
