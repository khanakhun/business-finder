import type { DomainCheck } from '@bf/contracts';

// Ports of deliverability (BF-056).

export interface ReadinessOverride {
  readonly mailboxId: string;
  readonly reason: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface MailboxHealthRow {
  readonly last50Sends: number;
  readonly last50Bounces: number;
  readonly bounces24h: number;
  readonly sends24h: number;
  readonly sends7d: number;
  readonly unsubscribes7d: number;
  readonly negative7d: number;
  readonly positive7d: number;
  readonly autoReplies7d: number;
  readonly deferrals7d: number;
  readonly daily: { day: string; sent: number; bounced: number; replies: number; failed: number }[];
}

export interface KillSwitchRow {
  readonly active: boolean;
  readonly reason: string | null;
  readonly by: string | null;
  readonly at: Date | null;
}

export interface DeliverabilityRepository {
  health(mailboxId: string, now: Date): Promise<MailboxHealthRow>;
  /** The mailbox an outbound message went from (the health of which a bounce or an unsubscribe changes). */
  mailboxOfMessage(messageId: string): Promise<{ organizationId: string; mailboxId: string } | undefined>;
  killSwitch(organizationId: string): Promise<KillSwitchRow>;
  setKillSwitch(organizationId: string, active: boolean, reason: string, by: string | null): Promise<void>;
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
