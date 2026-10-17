import { Injectable } from '@nestjs/common';
import { ComplianceService } from '../application/compliance.service.ts';

/** BF-028's pre-check port (enrichment's e-mail verification): a suppressed address is never sent a probe. */
@Injectable()
export class ComplianceEmailSuppression {
  constructor(private readonly compliance: ComplianceService) {}

  async isSuppressed(organizationId: string, address: string): Promise<boolean> {
    const domain = address.split('@')[1] ?? '';
    const hits = await this.compliance.isSuppressed(organizationId, [
      { scope: 'email', value: address },
      ...(domain ? [{ scope: 'domain' as const, value: domain }] : []),
    ]);
    return hits.length > 0;
  }
}
