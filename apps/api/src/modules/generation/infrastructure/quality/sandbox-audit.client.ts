import { createHash } from 'node:crypto';
import { RUNNER_PROTOCOL, type RunnerFrame } from '@bf/contracts/runner';
import type { SandboxRunSpec } from '@bf/contracts/sandbox';
import type { AuditReport } from '@bf/sitekit';
import type { SandboxProvider } from '../../application/sandbox.ports.ts';
import { ArtifactCollector } from '../engines/sandboxed/run-pieces.ts';
import { packBundle } from '../workspace/tar.ts';

// The render-based audits (BF-045) never run in the worker: `sitekit audit` runs in a sandbox (BF-043) with the
// quality profile — no network at all, no model key, the candidate site in the job's workspace — and its report comes
// back as an artifact. One run serves the accessibility and the performance gates; it is cached per candidate.

const REPORT = '.sitekit/audit.json';
const CACHE_SIZE = 50;

export interface AuditSandboxSettings {
  readonly image: string;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pidsLimit: number;
  /** The audit's wall time (target < 90 s for 4 pages × 2 locales). */
  readonly wallTimeSec: number;
}

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}

export class SandboxAuditClient {
  private readonly cache = new Map<string, Promise<AuditReport>>();

  constructor(
    private readonly sandbox: SandboxProvider,
    private readonly settings: AuditSandboxSettings,
  ) {}

  /** The audit of `spec` in the job's workspace (its files, with site.json replaced by the candidate). */
  audit(
    files: ReadonlyMap<string, Buffer>,
    spec: unknown,
    labels: { readonly jobId: string; readonly organizationId: string },
  ): Promise<AuditReport> {
    const site = Buffer.from(JSON.stringify(spec));
    const key = createHash('sha256').update(site).digest('hex');
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.run(files, site, labels, key);
      // A failed audit is not remembered: the gate's retry runs it again.
      pending.catch(() => this.cache.delete(key));
      this.cache.set(key, pending);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    }
    return pending;
  }

  private async run(
    files: ReadonlyMap<string, Buffer>,
    site: Buffer,
    labels: { readonly jobId: string; readonly organizationId: string },
    key: string,
  ): Promise<AuditReport> {
    const workspace = new Map(files);
    workspace.set('site.json', site);
    const spec: SandboxRunSpec = {
      image: this.settings.image,
      cpus: this.settings.cpus,
      memoryMb: this.settings.memoryMb,
      pidsLimit: this.settings.pidsLimit,
      tmpfsMb: { workspace: 512, tmp: 512, home: 128 },
      wallTimeSec: this.settings.wallTimeSec,
      // The quality profile: nothing leaves the sandbox; the page is served on 127.0.0.1 inside it.
      egressProfile: 'none',
      labels: { 'bf.job': labels.jobId, 'bf.org': labels.organizationId, 'bf.purpose': 'quality.audit' },
    };
    const collector = new ArtifactCollector(16 * 1024 * 1024);
    let exit: Extract<RunnerFrame, { t: 'exit' }> | undefined;
    const stderr: string[] = [];
    const controller = new AbortController();
    for await (const frame of this.sandbox.run(
      spec,
      {
        protocol: RUNNER_PROTOCOL,
        runId: `audit:${key.slice(0, 32)}`,
        command: ['sitekit', 'audit', '--json', '--out', REPORT],
        wallTimeSec: this.settings.wallTimeSec,
        // The audit is the run; no further check.
        checkCommand: ['true'],
        collect: [REPORT],
      },
      packBundle(workspace),
      controller.signal,
    )) {
      if (frame.t === 'artifact') collector.add(frame);
      else if (frame.t === 'stderr') stderr.push(frame.line);
      else if (frame.t === 'exit') exit = frame;
    }
    const body = collector.get(REPORT);
    if (exit?.reason !== 'completed' || !body)
      throw new AuditError(
        `sitekit audit did not complete (${exit?.reason ?? 'no exit'}): ${stderr.slice(-3).join(' | ').slice(0, 400)}`,
      );
    return JSON.parse(body.toString('utf8')) as AuditReport;
  }
}
