import type { EmailVerificationDetails, VerificationStatus } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { isFreeMailDomain } from '../../domain/value-objects/email-classification.ts';
import { CONTACT_REPOSITORY, type ContactRepository } from '../ports.ts';

/** A verifier's verdict on an e-mail address (BF-028). */
export interface EmailVerdict {
  readonly status: VerificationStatus;
  readonly details: EmailVerificationDetails;
  /** When the mailbox was checked (a cached verdict keeps its own time). */
  readonly verifiedAt: Date;
}

/**
 * Records a verdict on a business's e-mail contact (enrichment's `email_verify` step and on-demand checks), with the
 * address's free-mail flag (so contacts stored before BF-028 get it too). Returns whether anything changed;
 * recording the same verdict again is a no-op.
 */
@Injectable()
export class RecordEmailVerificationCommand {
  constructor(@Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository) {}

  execute(businessId: string, email: string, verdict: EmailVerdict): Promise<boolean> {
    const address = email.trim().toLowerCase();
    const isFreeMail = isFreeMailDomain(address.slice(address.lastIndexOf('@') + 1));
    return this.contacts.recordVerification(businessId, address, { ...verdict, isFreeMail });
  }
}
