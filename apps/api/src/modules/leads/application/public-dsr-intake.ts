import { type PublicDsrIntake as PublicDsrIntakeInput, verifySiteViewToken } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { DsrService } from '../../compliance/index.ts';
import { withoutClientDetails } from '../../platform/context/request-context.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import {
  LEAD_GUARD,
  LEAD_TOKEN_SECRET,
  LEADS_REPOSITORY,
  type LeadGuard,
  type LeadsRepository,
} from './ports.ts';
import { LeadCaptureDisabledError } from './public-leads.ts';

// "Exercise your rights" from a preview's privacy page (BF-055): the site token names the workspace; the request is
// recorded as `received` for a person to verify (nothing is exported or erased from here). Rate-limited like the lead
// forms; the answer is always the same.

@Injectable()
export class PublicDsrIntake {
  constructor(
    @Inject(LEADS_REPOSITORY) private readonly repository: LeadsRepository,
    @Inject(LEAD_GUARD) private readonly guard: LeadGuard,
    @Inject(LEAD_TOKEN_SECRET) private readonly secret: string | null,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly dsr: DsrService,
  ) {}

  async submit(input: PublicDsrIntakeInput, client: { ip: string | undefined }): Promise<{ received: true }> {
    if (!this.secret) throw new LeadCaptureDisabledError();
    const siteId = await verifySiteViewToken(input.siteToken, this.secret);
    const site = siteId ? await this.repository.siteForLead(siteId) : undefined;
    if (!siteId || !site) return { received: true };
    const network = await this.guard.networkHash(client.ip);
    if (
      (network && (await this.guard.overIpLimit(siteId, network))) ||
      (await this.guard.overSiteLimit(siteId))
    )
      return { received: true };
    await withoutClientDetails(() =>
      this.dsr.create(
        { organizationId: site.organizationId, userId: null },
        {
          type: input.type,
          subject: {
            email: input.email,
            ...(input.name ? { name: input.name } : {}),
            businessId: site.businessId as never,
          },
          ...(input.message ? { notes: input.message } : {}),
        },
        'public',
      ),
    );
    this.logger.info({ siteId, type: input.type }, 'public data-subject request received');
    return { received: true };
  }
}
