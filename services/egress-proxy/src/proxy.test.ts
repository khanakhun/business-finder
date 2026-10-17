import type { AddressInfo } from 'node:net';
import { connect, createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress } from './ip-policy.ts';
import {
  createEgressProxy,
  createMetricsServer,
  decide,
  EgressMetrics,
  matchesAllowlist,
  PROFILES,
  parseTarget,
} from './proxy.ts';

// The egress proxy (BF-043): what goes out (CONNECT 443 to allowlisted names, public addresses only) and what does
// not (everything else), with real sockets for the tunnel.

const PUBLIC = '93.184.216.34';
const allow = ['api.anthropic.com', '*.example-cdn.test'];
const resolveTable: Record<string, string[]> = {
  'api.anthropic.com': [PUBLIC],
  'img.example-cdn.test': ['10.0.0.5', PUBLIC],
  'rebind.example-cdn.test': ['127.0.0.1', '169.254.169.254'],
};
const resolve = async (host: string) => {
  const addresses = resolveTable[host];
  if (!addresses) throw new Error('ENOTFOUND');
  return addresses;
};

describe('decide', () => {
  it('allows CONNECT 443 to allowlisted names on a public address', async () => {
    expect(await decide('api.anthropic.com:443', { allow, resolve })).toMatchObject({
      decision: 'allowed',
      address: PUBLIC,
      port: 443,
    });
    expect(await decide('img.example-cdn.test:443', { allow, resolve })).toMatchObject({
      decision: 'allowed',
      address: PUBLIC,
    });
  });

  it('refuses other ports, IP literals, other hosts, private addresses and unknown names', async () => {
    expect((await decide('api.anthropic.com:80', { allow, resolve })).decision).toBe('denied_port');
    expect((await decide('93.184.216.34:443', { allow, resolve })).decision).toBe('denied_ip_literal');
    expect((await decide('[2606:2800::1]:443', { allow, resolve })).decision).toBe('denied_ip_literal');
    expect((await decide('evil.example:443', { allow, resolve })).decision).toBe('denied_host');
    expect((await decide('api.anthropic.com.evil.example:443', { allow, resolve })).decision).toBe(
      'denied_host',
    );
    expect((await decide('rebind.example-cdn.test:443', { allow, resolve })).decision).toBe(
      'denied_private_address',
    );
    expect((await decide('x.example-cdn.test:443', { allow, resolve })).decision).toBe('denied_dns');
    expect((await decide('garbage', { allow, resolve })).decision).toBe('denied_host');
  });

  it('matches allowlist patterns exactly', () => {
    expect(matchesAllowlist('API.Anthropic.com.', allow)).toBe(true);
    expect(matchesAllowlist('example-cdn.test', allow)).toBe(false);
    expect(matchesAllowlist('a.b.example-cdn.test', allow)).toBe(true);
    expect(matchesAllowlist('xexample-cdn.test', allow)).toBe(false);
    expect(parseTarget('host:99999')).toBeUndefined();
    expect(PROFILES.models).toEqual(['api.anthropic.com', 'api.openai.com']);
  });

  it('keeps the same IP policy as the API', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '::1',
      'fd00:ec2::254',
      '::ffff:10.0.0.1',
      '100.100.100.200',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of [PUBLIC, '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe('the proxy', () => {
  let upstream: Server;
  let upstreamPort = 0;
  let proxy: ReturnType<typeof createEgressProxy>;
  let proxyPort = 0;
  const metrics = new EgressMetrics(2);
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    upstream = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
    upstreamPort = (upstream.address() as AddressInfo).port;
    // The resolved public address is dialled as our local echo server: the tunnel is real, the internet is not used.
    proxy = createEgressProxy(
      { allow, resolve, dial: () => connect(upstreamPort, '127.0.0.1'), log: (entry) => logs.push(entry) },
      metrics,
    );
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    proxyPort = (proxy.address() as AddressInfo).port;
  });
  afterAll(async () => {
    proxy.close();
    upstream.close();
  });

  const send = (text: string) =>
    new Promise<string>((resolveText) => {
      const socket = connect(proxyPort, '127.0.0.1');
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk.toString();
        if (received.includes('\r\n\r\n') && received.startsWith('HTTP/1.1 200')) {
          socket.write('ping');
          if (received.endsWith('ping')) socket.end();
        }
      });
      socket.on('close', () => resolveText(received));
      socket.on('error', () => resolveText(received));
      socket.write(text);
      setTimeout(() => socket.destroy(), 2000);
    });

  it('tunnels an allowed CONNECT', async () => {
    const reply = await send('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
    expect(reply).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(reply.endsWith('ping')).toBe(true);
  });

  it('refuses everything else with 403, logs and counts it', async () => {
    for (const target of [
      'evil.example:443',
      'api.anthropic.com:22',
      '10.0.0.1:443',
      'other.example:443',
      'third.example:443',
    ])
      expect(await send(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)).toMatch(/^HTTP\/1\.1 403/);
    expect(await send('GET http://api.anthropic.com/ HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n')).toMatch(
      /^HTTP\/1\.1 403/,
    );
    expect(logs.filter((entry) => entry.msg === 'egress denied')).toHaveLength(6);
    const text = metrics.render();
    expect(text).toContain('sandbox_egress_requests_total{decision="allowed"} 1');
    expect(text).toContain('sandbox_egress_denied_total{host="evil.example"} 1');
    // Host labels are capped: later hosts count as "other".
    expect(text).toContain('sandbox_egress_denied_total{host="other"}');
  });

  it('serves metrics and health on its own server', async () => {
    const server = createMetricsServer(metrics);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as AddressInfo).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()).toContain(
      'sandbox_egress_denied_total',
    );
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
    server.close();
  });
});
