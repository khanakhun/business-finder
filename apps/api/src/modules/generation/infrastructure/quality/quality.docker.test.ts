import { describe, expect, it } from 'vitest';
import type { StoredJob } from '../../application/ports.ts';
import { evalWorkspace, loadBusinesses } from '../engines/blocks/eval/harness.ts';
import { HttpDockerApi } from '../sandbox/docker-engine.ts';
import { DockerSandboxProvider } from '../sandbox/docker-sandbox.ts';
import { unpackBundle } from '../workspace/tar.ts';
import { FullQualityPipeline } from './full-quality.pipeline.ts';
import { SandboxAuditClient } from './sandbox-audit.client.ts';

// The quality audits on a real daemon and the runner image (BF-045): `sitekit audit` (axe-core and Lighthouse) runs
// in a sandbox without any network, on a real workspace's starter site, and the pipeline scores it. Runs when
// DOCKER_SANDBOX_IMAGE names a built image (the CI runner job; locally `pnpm runner:build` then
// DOCKER_SANDBOX_IMAGE=bf-agent-runner:dev).

const image = process.env.DOCKER_SANDBOX_IMAGE;
const host = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock';

describe.runIf(Boolean(image))('quality audits in the sandbox', () => {
  const business = loadBusinesses().find((candidate) => candidate.id === 'salon-corail-gustavia-fr-rich');
  if (!business) throw new Error('missing eval business');
  const workspace = evalWorkspace(business);
  const client = new SandboxAuditClient(
    new DockerSandboxProvider(new HttpDockerApi(host), { network: 'none', killGraceMs: 2000 }),
    { image: image as string, cpus: 2, memoryMb: 2048, pidsLimit: 512, wallTimeSec: 240 },
  );

  it('audits every page with axe and home plus the heaviest inner page with Lighthouse, offline', async () => {
    const report = await client.audit(unpackBundle(Buffer.from(workspace.bundle)), workspace.starter, {
      jobId: 'docker-audit',
      organizationId: 'org-docker',
    });
    expect(report.pages).toEqual(workspace.starter.pages.map((page) => page.id));
    expect(report.lighthouse.map((finding) => `${finding.page}:${finding.preset}`)).toHaveLength(4);
    for (const finding of report.lighthouse) {
      expect(finding.scores.performance).toBeGreaterThanOrEqual(0);
      expect(finding.scores.accessibility).toBeGreaterThan(80);
    }
    expect(report.durationMs).toBeLessThan(180_000);
  }, 300_000);

  it('scores the starter site through the full pipeline', async () => {
    const pipeline = new FullQualityPipeline({
      artifacts: { get: async () => Buffer.from(workspace.bundle) },
      repository: { artifactKey: async () => 'bundle' },
      assetHosts: ['assets.bf-sites.test'],
      audits: client,
    });
    const result = await pipeline.evaluate({
      job: { id: 'docker-pipeline', organizationId: 'org-docker' } as StoredJob,
      spec: workspace.starter,
      repairsLeft: 2,
      supportsRepair: true,
      attemptId: 'a1',
    });
    const gates = Object.fromEntries((result.report?.gates ?? []).map((gate) => [gate.id, gate.status]));
    expect(gates).toMatchObject({ schema: 'pass', facts: 'pass', copy: 'pass' });
    expect(['pass', 'fail']).toContain(gates.a11y);
    expect(['pass', 'fail']).toContain(gates.performance);
    expect(result.report?.infraError).toBe(false);
    const scores = Object.fromEntries((result.report?.gates ?? []).map((gate) => [gate.id, gate.score]));
    expect(scores.a11y).toBeGreaterThan(80);
    expect(scores.performance).toBeGreaterThan(50);
  }, 300_000);
});
