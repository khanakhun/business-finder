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

/** A bare address from a hop: trims, unwraps `[v6]:port`, drops an IPv4 `:port`, unmaps `::ffff:`. */
function normalizeIp(hop: string): string {
  let ip = hop.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed?.[1]) ip = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  return ip.replace(/^::ffff:/, '');
}

/**
 * The client address we trust: walking back from the socket peer through X-Forwarded-For, skip
 * `AUTH_TRUSTED_PROXIES` hops and keep the first address that is not one. Entries a client prepends itself (left of
 * the last untrusted hop) are ignored, and an unparsable hop stops the walk. Null only when the socket has no
 * address.
 */
export function clientIp(
  req: Pick<Request, 'headers' | 'socket'>,
  isTrustedProxy: (ip: string) => boolean,
): string | null {
  const peer = normalizeIp(req.socket.remoteAddress ?? '');
  if (!peer) return null;
  const header = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').map(normalizeIp);
  let client = peer;
  while (isTrustedProxy(client) && hops.length > 0) {
    const next = hops.pop() as string;
    // An unparsable hop ends the walk: everything left of it may be client-supplied.
    if (isIP(next) === 0) break;
    client = next;
  }
  return client;
}
