import type { DomainCheck } from '@bf/contracts';

// Ports of deliverability (BF-056).

export interface ReadinessOverride {
  readonly mailboxId: string;
  readonly reason: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface DeliverabilityRepository {
  domainCheck(organizationId: string, domain: string): Promise<DomainCheck | undefined>;
  saveDomainCheck(organizationId: string, check: DomainCheck): Promise<void>;
  overrides(organizationId: string): Promise<ReadinessOverride[]>;
  override(organizationId: string, mailboxId: string): Promise<ReadinessOverride | undefined>;
  setOverride(organizationId: string, mailboxId: string, reason: string, by: string | null): Promise<void>;
  clearOverride(organizationId: string, mailboxId: string): Promise<boolean>;
}
export const DELIVERABILITY_REPOSITORY = Symbol('DeliverabilityRepository');

/** Whether a mailbox may send (the readiness gate), for the selector and the send path. */
export interface MailboxReadinessGate {
  isReady(organizationId: string, mailboxId: string, email: string): Promise<boolean>;
}
export const MAILBOX_READINESS = Symbol('MailboxReadinessGate');
