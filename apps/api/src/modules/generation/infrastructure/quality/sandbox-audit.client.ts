import { createHash } from 'node:crypto';
import { RUNNER_PROTOCOL, type RunnerFrame } from '@bf/contracts/runner';
import type { SandboxRunSpec } from '@bf/contracts/sandbox';
import { parseSite } from '@bf/site-schema';
import { ASSET_MAP, type AuditReport, referencedAssetUrls } from '@bf/sitekit';
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

/** The audit's report, with the critic's screenshots (by workspace file). */
export type AuditRun = AuditReport & { readonly images: ReadonlyMap<string, Buffer> };

export class AuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditError';
  }
}

/** Our asset CDN's files, read from storage (never over the network): what the rendered pages request. */
export interface AuditAssets {
  readonly hosts: readonly string[];
  fetch(url: string): Promise<Buffer | undefined>;
}

/** At most this many asset files, and bytes, are copied into an audit's workspace. */
const MAX_ASSETS = 300;
const MAX_ASSET_BYTES = 48 * 1024 * 1024;

export class SandboxAuditClient {
  private readonly cache = new Map<string, Promise<AuditRun>>();

  constructor(
    private readonly sandbox: SandboxProvider,
    private readonly settings: AuditSandboxSettings,
    private readonly assets?: AuditAssets,
  ) {}

  /** The site's assets copied into the workspace, with the URL → file map the audit's browser answers from. */
  private async withAssets(workspace: Map<string, Buffer>, spec: unknown): Promise<void> {
    if (!this.assets) return;
    const parsed = parseSite(spec);
    if (!parsed.spec) return;
    const map: Record<string, string> = {};
    let bytes = 0;
    for (const url of referencedAssetUrls(parsed.spec, this.assets.hosts).slice(0, MAX_ASSETS)) {
      const body = await this.assets.fetch(url).catch(() => undefined);
      if (!body || bytes + body.length > MAX_ASSET_BYTES) continue;
      bytes += body.length;
      const file = `.sitekit/asset-cache/${createHash('sha256').update(url).digest('hex').slice(0, 32)}`;
      workspace.set(file, body);
      map[url] = file;
    }
    workspace.set(ASSET_MAP, Buffer.from(JSON.stringify(map)));
  }

  /** The audit of `spec` in the job's workspace (its files, with site.json replaced by the candidate). */
  audit(
    files: ReadonlyMap<string, Buffer>,
    spec: unknown,
    labels: { readonly jobId: string; readonly organizationId: string },
  ): Promise<AuditRun> {
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
  ): Promise<AuditRun> {
    const workspace = new Map(files);
    workspace.set('site.json', site);
    await this.withAssets(workspace, JSON.parse(site.toString('utf8')) as unknown);
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
        command: ['sitekit', 'audit', '--screenshots', '--json', '--out', REPORT],
        wallTimeSec: this.settings.wallTimeSec,
        // The audit is the run; no further check.
        checkCommand: ['true'],
        collect: [REPORT, '.sitekit/audit/*.png'],
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
    const report = JSON.parse(body.toString('utf8')) as AuditReport;
    const images = new Map<string, Buffer>();
    for (const shot of report.screenshots ?? []) {
      const png = collector.get(shot.file);
      if (png) images.set(shot.file, png);
    }
    return { ...report, images };
  }
}
