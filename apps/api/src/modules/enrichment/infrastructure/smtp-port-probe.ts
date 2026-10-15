import { Resolver } from 'node:dns/promises';
import { connect } from 'node:net';
import type { Clock } from '@bf/contracts';
import type { SmtpPortProbe, SmtpProbeError } from '../application/ports.ts';

/** A large provider's mail domain: its MX accepts connections on port 25 from anywhere that is allowed out. */
const PROBE_DOMAIN = 'gmail.com';
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Opens (and immediately closes) a TCP connection to the probe domain's preferred MX on port 25 — no SMTP
 * conversation, no mail. Many VPS providers block outbound port 25: Reacher cannot check mailboxes there.
 */
export class TcpSmtpPortProbe implements SmtpPortProbe {
  constructor(
    private readonly clock: Clock,
    private readonly resolver: Pick<Resolver, 'resolveMx'> = new Resolver({ timeout: 3_000, tries: 2 }),
  ) {}

  async probe(signal: AbortSignal): ReturnType<SmtpPortProbe['probe']> {
    let host: string | null = null;
    try {
      const records = await this.resolver.resolveMx(PROBE_DOMAIN);
      host = [...records].sort((a, b) => a.priority - b.priority)[0]?.exchange || null;
    } catch {
      return { reachable: false, host: null, latencyMs: null, error: 'dns' };
    }
    if (!host) return { reachable: false, host: null, latencyMs: null, error: 'dns' };
    const started = this.clock.now().getTime();
    const error = await this.connect(host, signal);
    return {
      reachable: error === null,
      host,
      latencyMs: error === null ? Math.max(0, this.clock.now().getTime() - started) : null,
      error,
    };
  }

  private connect(host: string, signal: AbortSignal): Promise<SmtpProbeError | null> {
    return new Promise((resolve) => {
      const socket = connect({ host, port: 25, timeout: CONNECT_TIMEOUT_MS });
      const done = (result: SmtpProbeError | null) => {
        signal.removeEventListener('abort', onAbort);
        socket.destroy();
        resolve(result);
      };
      const onAbort = () => done('timeout');
      signal.addEventListener('abort', onAbort, { once: true });
      socket.once('connect', () => done(null));
      socket.once('timeout', () => done('timeout'));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        done(
          error.code === 'ECONNREFUSED'
            ? 'refused'
            : error.code === 'ENETUNREACH' || error.code === 'EHOSTUNREACH'
              ? 'unreachable'
              : error.code === 'ETIMEDOUT'
                ? 'timeout'
                : 'other',
        );
      });
    });
  }
}

/** Tests and E2E (`FAKE_EMAIL_VERIFIER`): port 25 is open, nothing is dialled. */
export class FakeSmtpPortProbe implements SmtpPortProbe {
  async probe(): ReturnType<SmtpPortProbe['probe']> {
    return { reachable: true, host: 'mx.example.test', latencyMs: 12, error: null };
  }
}
