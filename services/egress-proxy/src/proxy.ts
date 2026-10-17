import { lookup } from 'node:dns/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { isPublicAddress } from './ip-policy.ts';

// The sandbox egress proxy (BF-043): the only way out of the internal `bf-sandbox` network. HTTPS `CONNECT` to port
// 443 of allowlisted hostnames only; the hostname is resolved here and the tunnel goes to a public address of it
// (no private, loopback, link-local or metadata address, whatever DNS says — so no rebinding). Everything else —
// plain HTTP, other ports, IP literals, other hosts — is refused, logged and counted.

export const PROFILES = {
  /** The model APIs the pinned CLIs call with API keys (Claude Code, Codex). */
  models: ['api.anthropic.com', 'api.openai.com'],
  /** Plus approved image CDNs (off by default: workspaces carry their images). */
  models_assets: ['api.anthropic.com', 'api.openai.com', 'images.unsplash.com', 'images.pexels.com'],
} as const;
export type EgressProfile = keyof typeof PROFILES;

export type Decision =
  | 'allowed'
  | 'denied_method'
  | 'denied_port'
  | 'denied_ip_literal'
  | 'denied_host'
  | 'denied_private_address'
  | 'denied_dns'
  | 'upstream_error';

export interface EgressOptions {
  /** Hostnames (`api.example.com`) or suffix patterns (`*.example.com`). */
  readonly allow: readonly string[];
  readonly resolve?: (host: string) => Promise<string[]>;
  readonly dial?: (port: number, address: string) => Socket;
  readonly log?: (entry: Record<string, unknown>) => void;
  /** Idle tunnels are closed after this long. */
  readonly idleMs?: number;
}

/** Counters in Prometheus text format; host labels capped (an agent could otherwise mint unbounded series). */
export class EgressMetrics {
  private readonly decisions = new Map<Decision, number>();
  private readonly denied = new Map<string, number>();
  constructor(private readonly maxHosts = 100) {}
  record(decision: Decision, host: string) {
    this.decisions.set(decision, (this.decisions.get(decision) ?? 0) + 1);
    if (decision.startsWith('denied')) {
      const label = this.denied.has(host) || this.denied.size < this.maxHosts ? host : 'other';
      this.denied.set(label, (this.denied.get(label) ?? 0) + 1);
    }
  }
  render(): string {
    const label = (value: string) => value.replace(/["\\\n]/g, '_');
    return [
      '# HELP sandbox_egress_requests_total Egress proxy decisions.',
      '# TYPE sandbox_egress_requests_total counter',
      ...[...this.decisions].map(
        ([decision, count]) => `sandbox_egress_requests_total{decision="${decision}"} ${count}`,
      ),
      '# HELP sandbox_egress_denied_total Refused egress attempts from sandboxes, by requested host.',
      '# TYPE sandbox_egress_denied_total counter',
      ...[...this.denied].map(
        ([host, count]) => `sandbox_egress_denied_total{host="${label(host)}"} ${count}`,
      ),
      '',
    ].join('\n');
  }
}

export function matchesAllowlist(host: string, allow: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return allow.some((pattern) => {
    const rule = pattern.toLowerCase();
    return rule.startsWith('*.')
      ? name.endsWith(rule.slice(1)) && name.length > rule.length - 1
      : name === rule;
  });
}

/** `host:port` of a CONNECT request target (IPv6 literals in brackets). */
export function parseTarget(target: string): { host: string; port: number } | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(target);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return undefined;
  return { host: (match[1] as string).replace(/^\[|\]$/g, ''), port };
}

export async function decide(
  target: string,
  options: Pick<EgressOptions, 'allow' | 'resolve'>,
): Promise<{ decision: Decision; host: string; address?: string; port?: number }> {
  const parsed = parseTarget(target);
  if (!parsed) return { decision: 'denied_host', host: target.slice(0, 200) };
  const { host, port } = parsed;
  if (port !== 443) return { decision: 'denied_port', host };
  if (isIP(host)) return { decision: 'denied_ip_literal', host };
  if (!matchesAllowlist(host, options.allow)) return { decision: 'denied_host', host };
  let addresses: string[];
  try {
    addresses = await (options.resolve ?? defaultResolve)(host);
  } catch {
    return { decision: 'denied_dns', host };
  }
  const address = addresses.find(isPublicAddress);
  if (!address) return { decision: 'denied_private_address', host };
  return { decision: 'allowed', host, address, port };
}

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export function createEgressProxy(options: EgressOptions, metrics = new EgressMetrics()): Server {
  const log = options.log ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));
  const server = createServer((request, response) => {
    // Plain HTTP (an absolute-URI request) never goes out.
    metrics.record('denied_method', request.headers.host ?? 'unknown');
    log({
      msg: 'egress denied',
      decision: 'denied_method',
      method: request.method,
      client: request.socket.remoteAddress,
    });
    response
      .writeHead(403, { 'content-type': 'text/plain' })
      .end('Only HTTPS CONNECT to allowlisted hosts.\n');
  });
  server.on('connect', async (request: IncomingMessage, client: Socket, head: Buffer) => {
    const client_ = request.socket.remoteAddress;
    client.on('error', () => client.destroy());
    const verdict = await decide(request.url ?? '', options);
    metrics.record(verdict.decision, verdict.host);
    if (verdict.decision !== 'allowed' || !verdict.address || !verdict.port) {
      log({ msg: 'egress denied', decision: verdict.decision, host: verdict.host, client: client_ });
      client.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nEgress refused.\n');
      return;
    }
    const upstream = (options.dial ?? ((port, address) => connect(port, address)))(
      verdict.port,
      verdict.address,
    );
    const idle = options.idleMs ?? 10 * 60_000;
    upstream.setTimeout(idle, () => upstream.destroy());
    client.setTimeout(idle, () => client.destroy());
    upstream.once('connect', () => {
      log({ msg: 'egress allowed', host: verdict.host, address: verdict.address, client: client_ });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once('error', (error) => {
      metrics.record('upstream_error', verdict.host);
      log({ msg: 'egress upstream error', host: verdict.host, error: error.message, client: client_ });
      if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      client.destroy();
    });
    client.once('close', () => upstream.destroy());
  });
  return server;
}

/** Metrics and health on a separate port (never reachable from the sandbox network in deployment). */
export function createMetricsServer(metrics: EgressMetrics): Server {
  return createServer((request, response) => {
    if (request.url === '/metrics')
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
    else if (request.url === '/health') response.writeHead(200).end('ok');
    else response.writeHead(404).end();
  });
}
