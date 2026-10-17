import type { QualityGateId, QualityReport } from '@bf/contracts';
import { describe, expect, it, vi } from 'vitest';
import { GenerationReview } from './generation.review.ts';
import type { StoredJob } from './ports.ts';

// Review decisions (BF-045): a version whose schema or facts failed is never published, not even by a person; a
// report without a repairable issue gives nothing to repair; a screenshot is served only from the job's own refs.

const actor = { organizationId: 'org-1', userId: 'user-1' };
const job = {
  id: 'job-1',
  organizationId: 'org-1',
  batchId: 'batch-1',
  status: 'needs_review',
  siteId: 'site-1',
  resultVersionId: 'version-1',
  engineCurrent: 'fake',
  attemptCount: 3,
  priority: 0,
  position: 0,
} as unknown as StoredJob;

const report = (failing: QualityGateId[], issues: QualityReport['issues'] = []): QualityReport => ({
  pipelineVersion: 1,
  candidateHash: 'a'.repeat(64),
  score: 30,
  decision: 'needs_review',
  infraError: false,
  gates: (['schema', 'facts', 'copy'] as const).map((id) => ({
    id,
    status: failing.includes(id) ? 'fail' : 'pass',
    durationMs: 1,
    costUsd: 0,
    issues: [],
  })),
  autoFixes: [],
  issues,
  screenshots: [
    { page: 'home', viewport: 'desktop', ref: 'generation/org-1/job-1/quality/abc/home.desktop.png' },
    { page: 'home', viewport: 'mobile', ref: 'generation/org-2/job-9/quality/abc/home.mobile.png' },
  ],
  createdAt: '2026-10-17T08:00:00.000Z',
});

function review(quality: QualityReport | null) {
  const sites = {
    versionQuality: vi.fn(async () => quality),
    publishPreview: vi.fn(async () => 'https://x.sites.test/'),
  };
  const transitions = { move: vi.fn(async () => undefined), dispatch: vi.fn(async () => undefined) };
  const artifacts = { get: vi.fn(async () => Buffer.from('png')), put: vi.fn(async () => undefined) };
  const service = new GenerationReview(
    {
      jobById: async () => job,
      attempts: async () => [{ attemptNo: 3, specRef: 'spec' }],
      appendEvents: async () => [1],
    } as never,
    { get: () => ({ capabilities: { supportsRepair: true } }) } as never,
    { run: vi.fn(async () => undefined) } as never,
    { resolve: async () => ({ allowedEngines: ['fake'], failoverChain: ['fake'] }) } as never,
    artifacts as never,
    sites as never,
    transitions as never,
    { record: vi.fn(async () => undefined) } as never,
  );
  return { service, sites, transitions, artifacts };
}

describe('GenerationReview', () => {
  it('refuses to publish a version whose schema or facts failed, or without a report', async () => {
    for (const gate of ['schema', 'facts'] as const) {
      const { service, sites } = review(report([gate]));
      await expect(service.accept(actor, 'job-1', 'The owner asked for it.')).rejects.toMatchObject({
        details: { reason: 'ACCEPT_BLOCKED' },
      });
      expect(sites.publishPreview).not.toHaveBeenCalled();
    }
    await expect(
      review(null).service.accept(actor, 'job-1', 'The owner asked for it.'),
    ).rejects.toMatchObject({
      details: { reason: 'NO_QUALITY_REPORT' },
    });
    const { service, transitions } = review(report(['copy']));
    await service.accept(actor, 'job-1', 'Copy warnings are acceptable here.');
    expect(transitions.move).toHaveBeenCalledWith(
      'job-1',
      'succeeded',
      expect.objectContaining({ publishedUrl: 'https://x.sites.test/' }),
    );
  });

  it('repairs only when the report holds a repairable, non-platform issue', async () => {
    const platform = report(
      ['copy'],
      [
        {
          gate: 'performance',
          code: 'lighthouse.performance',
          severity: 'error',
          message: 'x',
          repairable: false,
          autoFixable: false,
          platform: true,
        },
      ],
    );
    await expect(review(platform).service.repair(actor, 'job-1')).rejects.toMatchObject({
      details: { reason: 'NOTHING_TO_REPAIR' },
    });
    const content = report(
      ['copy'],
      [
        {
          gate: 'copy',
          code: 'copy.placeholder',
          severity: 'error',
          message: 'x',
          repairable: true,
          autoFixable: false,
          target: { path: 'pages[0].blocks[0].props.title.fr' },
        },
      ],
    );
    const { service, artifacts, transitions } = review(content);
    await service.repair(actor, 'job-1');
    const written = JSON.parse(
      (artifacts.put.mock.calls[0] as unknown as [string, Buffer])[1].toString(),
    ) as { issues: { at: string }[] };
    expect(written.issues[0]?.at).toBe('pages[0].blocks[0].props.title.fr');
    expect(transitions.move).toHaveBeenCalledWith('job-1', 'repairing', expect.anything());
  });

  it('serves only the job’s own screenshots', async () => {
    const { service } = review(report([]));
    await expect(service.screenshot(actor, 'job-1', 0)).resolves.toBeInstanceOf(Buffer);
    await expect(service.screenshot(actor, 'job-1', 1)).rejects.toThrow();
    await expect(service.screenshot(actor, 'job-1', 7)).rejects.toThrow();
  });
});
