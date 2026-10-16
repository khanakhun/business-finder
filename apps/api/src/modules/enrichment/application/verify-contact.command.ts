import { NotFoundError, ValidationError } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { EmailContactsQuery } from '../../business-graph/index.ts';
import { StartEnrichmentCommand, type StartOutcome } from './enrichment.use-cases.ts';
import { SUBJECT_READER, type SubjectReader } from './ports.ts';

/**
 * On-demand verification of one e-mail contact (BF-028): an enrichment run of `email_verify` alone for its business
 * (no crawl first), so budgets, politeness, retries and progress are the engine's. Every stale address of the
 * business is checked with it; fresh verdicts come from the cache (an address is checked at most once per TTL).
 */
@Injectable()
export class VerifyContactCommand {
  constructor(
    private readonly contacts: EmailContactsQuery,
    @Inject(SUBJECT_READER) private readonly subjects: SubjectReader,
    private readonly start: StartEnrichmentCommand,
  ) {}

  async execute(input: {
    readonly organizationId: string;
    readonly userId: string | null;
    readonly contactId: string;
  }): Promise<StartOutcome> {
    const contact = await this.contacts.find(input.contactId);
    // Another workspace's business is "not found", like a contact that does not exist.
    if (!contact || !(await this.subjects.tracks(input.organizationId, contact.businessId))) {
      throw new NotFoundError('Contact', input.contactId);
    }
    if (contact.type !== 'email') {
      throw new ValidationError('Only e-mail contacts can be verified.', [
        { path: ['id'], message: 'not an e-mail contact' },
      ]);
    }
    return this.start.execute({
      organizationId: input.organizationId,
      businessId: contact.businessId,
      requestedBy: input.userId,
      trigger: 'manual',
      steps: ['email_verify'],
      force: false,
      idempotencyKey: null,
      withoutOptionalDependencies: true,
    });
  }
}
