import type { SiteCommands } from '../../sites/application/sites.commands.ts';
import type { SiteQueries } from '../../sites/application/sites.queries.ts';
import type { SiteHandOff } from '../application/ports.ts';

// The sites module receives generated sites (BF-039 → BF-035): a new version authored by the generation job on the
// business's site (created when it has none), then, when asked, a preview publication.

export class SitesModuleHandOff implements SiteHandOff {
  constructor(
    private readonly commands: Pick<
      SiteCommands,
      'create' | 'createVersion' | 'publishPreview' | 'recordQuality'
    >,
    private readonly queries: Pick<SiteQueries, 'get' | 'version'>,
  ) {}

  async createVersion(input: Parameters<SiteHandOff['createVersion']>[0]) {
    const actor = { organizationId: input.organizationId, userId: input.userId };
    const siteId =
      input.siteId ?? (await this.commands.create(actor, { businessId: input.businessId })).siteId;
    const site = await this.queries.get(input.organizationId, siteId);
    const version = await this.commands.createVersion(
      actor,
      siteId,
      {
        spec: input.spec,
        baseVersionId: site.currentVersion?.id ?? null,
        changeSummary: input.changeSummary,
      },
      { type: 'generation_job', id: input.jobId },
    );
    return { siteId, versionId: version.id };
  }

  async versionQuality(organizationId: string, siteId: string, versionId: string) {
    return (await this.queries.version(organizationId, siteId, versionId)).quality ?? null;
  }

  async recordQuality(input: Parameters<SiteHandOff['recordQuality']>[0]) {
    await this.commands.recordQuality(
      { organizationId: input.organizationId, userId: null },
      input.siteId,
      input.versionId,
      input.report as unknown as Record<string, unknown>,
    );
  }

  async publishPreview(input: Parameters<SiteHandOff['publishPreview']>[0]) {
    const actor = { organizationId: input.organizationId, userId: input.userId };
    await this.commands.publishPreview(actor, input.siteId, {
      versionId: input.versionId,
      expiresInDays: 30,
    });
    return (await this.queries.get(input.organizationId, input.siteId)).preview?.url ?? null;
  }
}
