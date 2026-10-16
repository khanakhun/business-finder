import { type AiGateway, WebsiteVisionGrade, type WebsiteVisionGradeOutput } from '@bf/ai';
import { type Clock, VISION_CRITERIA, type VisionGrade } from '@bf/contracts';
import type { ObjectStorage } from '../../platform/storage/object-storage.ts';
import type { VisionGrader, WebsiteSnapshotRecord } from '../application/ports.ts';

// Vision grading of a snapshot's screenshots (BF-030): `website.vision_grade` (smart tier) through the AI gateway,
// and a deterministic fake for tests and E2E (`FAKE_WEBSITE_AUDIT`).

const toGrade = (
  output: WebsiteVisionGradeOutput,
  meta: { readonly model: string; readonly promptVersion: number; readonly gradedAt: Date },
): VisionGrade => ({
  criteria: output.criteria,
  overall: output.overall,
  summary: output.summary,
  model: meta.model,
  promptVersion: meta.promptVersion,
  gradedAt: meta.gradedAt.toISOString(),
});

export class LlmVisionGrader implements VisionGrader {
  constructor(
    private readonly gateway: AiGateway,
    private readonly artifacts: ObjectStorage,
    private readonly clock: Clock,
  ) {}

  async grade(
    organizationId: string,
    snapshot: WebsiteSnapshotRecord,
    subject: { readonly displayName: string; readonly categoryLabel: string | null },
    signal: AbortSignal,
  ): Promise<{ readonly grade: VisionGrade; readonly costUsd: number } | null> {
    const { desktopKey, mobileKey } = snapshot.intel.screenshots;
    // Only this business's crawl artifacts, whatever a stored key says.
    const own = (key: string | null) =>
      key && key.startsWith(`sites/${snapshot.businessId}/`) && !key.split('/').includes('..') ? key : null;
    const keys = [own(desktopKey), own(mobileKey)].filter((key): key is string => key !== null);
    if (keys.length === 0) return null;
    const images = [];
    for (const key of keys) {
      const object = await this.artifacts.get(key);
      if (object) images.push({ bytes: new Uint8Array(object.body), mediaType: object.contentType });
    }
    if (images.length === 0) return null;
    const result = await this.gateway.vision(
      WebsiteVisionGrade,
      {
        input: {
          businessName: subject.displayName,
          ...(subject.categoryLabel ? { category: subject.categoryLabel.slice(0, 100) } : {}),
          url: snapshot.intel.finalUrl ?? snapshot.url,
        },
        images,
      },
      { orgId: organizationId, signal },
    );
    return {
      grade: toGrade(result.output as WebsiteVisionGradeOutput, {
        model: result.model,
        promptVersion: result.promptVersion,
        gradedAt: this.clock.now(),
      }),
      costUsd: result.costUsd ?? 0,
    };
  }
}

/**
 * Grades for tests and E2E (`FAKE_WEBSITE_AUDIT`; refused in production): a host containing `ugly` gets a poor
 * grade, any other a good one. No screenshot or model is needed.
 */
export class FakeVisionGrader implements VisionGrader {
  constructor(private readonly clock: Clock) {}

  async grade(
    _organizationId: string,
    snapshot: WebsiteSnapshotRecord,
  ): Promise<{ readonly grade: VisionGrade; readonly costUsd: number }> {
    const ugly = new URL(snapshot.intel.finalUrl ?? snapshot.url).hostname.includes('ugly');
    const score = ugly ? 3 : 8;
    const criteria = Object.fromEntries(
      VISION_CRITERIA.map((id) => [
        id,
        {
          score,
          evidence: ugly
            ? 'Cramped table layout with small text and no visible button.'
            : 'Clean layout with a clear headline and a prominent button.',
        },
      ]),
    ) as VisionGrade['criteria'];
    return {
      grade: {
        criteria,
        overall: score,
        summary: ugly
          ? {
              en: 'The page looks dated and is hard to use on a phone.',
              fr: 'La page paraît datée et peu pratique sur mobile.',
            }
          : {
              en: 'A modern, clear page with an obvious call to action.',
              fr: 'Une page moderne et claire, avec un appel à l’action évident.',
            },
        model: 'fake-vision-grader',
        promptVersion: 1,
        gradedAt: this.clock.now().toISOString(),
      },
      costUsd: 0,
    };
  }
}
