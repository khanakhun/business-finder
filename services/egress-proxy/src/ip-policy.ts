import { BlockList, isIPv4, isIPv6 } from 'node:net';

// Which addresses the sandbox egress proxy may connect to (BF-043): a copy of apps/api's `platform/security/ip-policy.ts`
// (security.md §4) — globally routable unicast only; services cannot import from apps. Keep the two in step.
// IPv6 addresses that embed an IPv4 address are judged by the embedded one; Teredo is refused outright.

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT (100.100.100.200: Alibaba metadata)
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (incl. fd00:ec2::254, AWS metadata)
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** The eight 16-bit groups of an IPv6 address (with a dotted IPv4 tail expanded), or null when malformed. */
function hextets(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0] ?? '';
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const octets = dotted[1].split('.').map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 0) return null;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill('0'), ...right].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

const v4 = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

/** The IPv4 address an IPv6 address carries (IPv4-mapped, NAT64 64:ff9b::/96, 6to4 2002::/16), if any. */
function embeddedIPv4(ip: string): string | null {
  const g = hextets(ip);
  if (!g) return null;
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return g5 === 0 && g6 === 0 ? null : v4(g6, g7); // ::ffff:a.b.c.d (and deprecated ::a.b.c.d)
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4(g6, g7);
  if (g0 === 0x2002) return v4(g1 ?? 0, g2 ?? 0);
  return null;
}

/** Whether `ip` is a public unicast address an outbound connection may reach. */
export function isPublicAddress(ip: string): boolean {
  if (isIPv4(ip)) return !BLOCKED.check(ip, 'ipv4');
  if (!isIPv6(ip)) return false;
  const inner = embeddedIPv4(ip);
  if (inner !== null) return isPublicAddress(inner);
  return !BLOCKED.check(ip, 'ipv6');
}
