import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { trustedProxyMatcher } from '../../platform/security/client-ip.ts';
import { isAllowedAuthPath, pinClientIp } from './better-auth-http.ts';

describe('isAllowedAuthPath', () => {
  it.each([
    ['/sign-in/email', true],
    ['/callback/google', true],
    ['/two-factor/verify-totp', true],
    ['/organization/accept-invitation', true],
    ['/reset-password/abc123', true],
    ['/organization/invite-member', false],
    ['/organization/update-member-role', false],
    ['/api-key/create', false],
    ['/admin/list-users', false],
    ['/two-factor/../organization/leave', false],
  ])('%s → %s', (path, expected) => {
    expect(isAllowedAuthPath(path)).toBe(expected);
  });
});

describe('pinClientIp', () => {
  const trusted = trustedProxyMatcher(['10.0.0.1']);
  const request = (peer: string | undefined, xff?: string) =>
    ({
      socket: { remoteAddress: peer },
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    }) as unknown as Pick<Request, 'headers' | 'socket'>;

  it('keeps X-Forwarded-For set by a trusted proxy', () => {
    const req = request('10.0.0.1', '203.0.113.5');
    pinClientIp(req, trusted);
    expect(req.headers['x-forwarded-for']).toBe('203.0.113.5');
  });

  it('ignores entries the client prepended before the trusted proxy appended its peer', () => {
    const req = request('10.0.0.1', '192.0.2.66, 203.0.113.5');
    pinClientIp(req, trusted);
    expect(req.headers['x-forwarded-for']).toBe('203.0.113.5');
  });

  it('skips several trusted hops and junk entries', () => {
    const chain = trustedProxyMatcher(['10.0.0.0/8']);
    const req = request('10.0.0.1', '203.0.113.5, not-an-ip, 10.1.2.3');
    pinClientIp(req, chain);
    expect(req.headers['x-forwarded-for']).toBe('203.0.113.5');
  });

  it('replaces a header sent by anyone else with their address (no spoofing past the rate limits)', () => {
    const req = request('::ffff:198.51.100.9', '203.0.113.5');
    pinClientIp(req, trusted);
    expect(req.headers['x-forwarded-for']).toBe('198.51.100.9');
  });

  it('sets the peer address when no header is present (no shared bucket for header-less clients)', () => {
    const fromProxy = request('10.0.0.1');
    pinClientIp(fromProxy, trusted);
    expect(fromProxy.headers['x-forwarded-for']).toBe('10.0.0.1');
    const direct = request('198.51.100.9');
    pinClientIp(direct, trusted);
    expect(direct.headers['x-forwarded-for']).toBe('198.51.100.9');
  });

  it('drops the header when the peer address is unknown', () => {
    const req = request(undefined, '203.0.113.5');
    pinClientIp(req, trusted);
    expect(req.headers['x-forwarded-for']).toBeUndefined();
  });
});
