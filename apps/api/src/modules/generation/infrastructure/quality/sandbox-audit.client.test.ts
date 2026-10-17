import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RunnerFrame, RunnerInput } from '@bf/contracts/runner';
import type { SandboxRunSpec } from '@bf/contracts/sandbox';
import { describe, expect, it } from 'vitest';
import type { SandboxProvider } from '../../application/sandbox.ports.ts';
import { evalWorkspace, loadBusinesses } from '../engines/blocks/eval/harness.ts';
import { unpackBundle } from '../workspace/tar.ts';
import { SandboxAuditClient } from './sandbox-audit.client.ts';

// The audit client (BF-045) with a scripted sandbox: the quality profile (no network, no key), the candidate and our
// assets in the workspace (read from storage, mapped by URL), the report and screenshots back, cached per candidate,
// and an incomplete run as an error.

const [business] = loadBusinesses();
if (!business) throw new Error('no eval business');
const workspace = evalWorkspace(business);
const files = unpackBundle(Buffer.from(workspace.bundle));
const artifact = (name: string, body: Buffer): RunnerFrame => ({
  t: 'artifact',
  name,
  sha256: createHash('sha256').update(body).digest('hex'),
  bytes: body.length,
  seq: 0,
  last: true,
  data: body.toString('base64'),
});

class Scripted implements SandboxProvider {
  readonly id = 'scripted';
  runs: { spec: SandboxRunSpec; input: RunnerInput; bundle: Uint8Array }[] = [];
  constructor(private readonly reason: 'completed' | 'timeout' = 'completed') {}
  async ready() {
    return { ready: true };
  }
  async *run(spec: SandboxRunSpec, input: RunnerInput, bundle: Uint8Array) {
    this.runs.push({ spec, input, bundle });
    const report = {
      axe: [],
      lighthouse: [],
      pages: ['home'],
      durationMs: 5,
      screenshots: [{ page: 'home', viewport: 'desktop', file: '.sitekit/audit/home.desktop.png' }],
    };
    if (this.reason === 'completed') {
      yield artifact('.sitekit/audit.json', Buffer.from(JSON.stringify(report)));
      yield artifact('.sitekit/audit/home.desktop.png', Buffer.from('\u0089PNG-bytes'));
    }
    yield { t: 'exit', code: this.reason === 'completed' ? 0 : 124, reason: this.reason } as RunnerFrame;
  }
}

const settings = { image: 'bf-agent-runner:dev', cpus: 2, memoryMb: 2048, pidsLimit: 512, wallTimeSec: 180 };
const labels = { jobId: 'job-1', organizationId: 'org-1' };

describe('SandboxAuditClient', () => {
  it('runs the audit offline on the candidate with our assets, and caches it per candidate', async () => {
    const sandbox = new Scripted();
    const fetched: string[] = [];
    const client = new SandboxAuditClient(sandbox, settings, {
      hosts: ['assets.bf-sites.test'],
      fetch: async (url) => {
        fetched.push(url);
        return Buffer.from(`bytes of ${url}`);
      },
    });
    // A site whose pages show images from our CDN (sitekit's salon fixture).
    const site = JSON.parse(
      readFileSync(
        new URL('../../../../../../../packages/sitekit/fixtures/workspace-salon/site.json', import.meta.url),
        'utf8',
      ),
    ) as unknown;
    const run = await client.audit(files, site, labels);
    expect(run.screenshots).toHaveLength(1);
    expect(run.images.get('.sitekit/audit/home.desktop.png')?.toString()).toContain('PNG');
    const [first] = sandbox.runs;
    expect(first?.spec).toMatchObject({ egressProfile: 'none', labels: { 'bf.purpose': 'quality.audit' } });
    expect(first?.input).toMatchObject({
      command: ['sitekit', 'audit', '--screenshots', '--json', '--out', '.sitekit/audit.json'],
      checkCommand: ['true'],
    });
    expect(first?.input.env ?? {}).toEqual({});
    const sent = unpackBundle(Buffer.from(first?.bundle ?? new Uint8Array()));
    expect(JSON.parse(sent.get('site.json')?.toString() ?? '{}')).toEqual(site);
    const map = JSON.parse(sent.get('.sitekit/asset-map.json')?.toString() ?? '{}') as Record<string, string>;
    for (const [url, file] of Object.entries(map)) expect(sent.get(file)?.toString()).toBe(`bytes of ${url}`);
    expect(Object.keys(map).length).toBeGreaterThan(0);
    expect(Object.keys(map).sort()).toEqual([...fetched].sort());
    expect(Object.keys(map).every((url) => url.startsWith('https://assets.bf-sites.test/'))).toBe(true);
    // The same candidate again: no second run.
    await client.audit(files, site, labels);
    expect(sandbox.runs).toHaveLength(1);
  });

  it('reports an incomplete audit as an error, and runs it again next time', async () => {
    const sandbox = new Scripted('timeout');
    const client = new SandboxAuditClient(sandbox, settings);
    await expect(client.audit(files, workspace.starter, labels)).rejects.toThrow(
      /did not complete \(timeout\)/,
    );
    await expect(client.audit(files, workspace.starter, labels)).rejects.toThrow();
    expect(sandbox.runs).toHaveLength(2);
  });
});
