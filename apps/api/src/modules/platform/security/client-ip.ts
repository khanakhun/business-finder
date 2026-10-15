import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';

/** `AUTH_TRUSTED_PROXIES` (IPs or CIDRs) as a matcher. */
export function trustedProxyMatcher(proxies: readonly string[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const entry of proxies) {
    const [address = '', bits] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(bits), family);
  }
  return (ip) => {
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
  };
}

const normalizeIp = (ip: string) => ip.trim().replace(/^::ffff:/, '');

/**
 * The client address we trust: walking back from the socket peer through X-Forwarded-For, skip
 * `AUTH_TRUSTED_PROXIES` hops and keep the first address that is not one. Entries a client prepends itself (left of
 * the last untrusted hop) are ignored. Null only when the socket has no address.
 */
export function clientIp(
  req: Pick<Request, 'headers' | 'socket'>,
  isTrustedProxy: (ip: string) => boolean,
): string | null {
  const peer = normalizeIp(req.socket.remoteAddress ?? '');
  if (!peer) return null;
  const header = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map(normalizeIp)
    .filter((hop) => isIP(hop) !== 0);
  let client = peer;
  while (isTrustedProxy(client) && hops.length > 0) client = hops.pop() as string;
  return client;
}
