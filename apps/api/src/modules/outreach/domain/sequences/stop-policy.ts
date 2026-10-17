import type { StopReason } from '@bf/contracts';

// When a sequence must stop (BF-053, Specification): evaluated on every tick before a step runs and by the event
// subscribers between ticks. The first reason that holds wins.

export const STOP_PIPELINE = ['engaged', 'meeting', 'proposal', 'won', 'lost', 'disqualified'] as const;

export interface StopFacts {
  readonly humanReply: boolean;
  readonly hardBounce: boolean;
  readonly unsubscribed: boolean;
  readonly suppressed: boolean;
  readonly doNotContact: boolean;
  readonly leadCaptured: boolean;
  readonly pipelineStatus: string | null;
  readonly contactInvalid: boolean;
  readonly mailboxRemoved: boolean;
  readonly complianceBlocked: boolean;
  readonly stopOnLead: boolean;
}

export function shouldStop(facts: StopFacts): StopReason | null {
  if (facts.humanReply) return 'replied';
  if (facts.hardBounce) return 'bounced';
  if (facts.unsubscribed) return 'unsubscribed';
  if (facts.suppressed) return 'suppressed';
  if (facts.doNotContact) return 'do_not_contact';
  if (facts.leadCaptured && facts.stopOnLead) return 'converted';
  if (facts.pipelineStatus && (STOP_PIPELINE as readonly string[]).includes(facts.pipelineStatus))
    return 'pipeline_changed';
  if (facts.contactInvalid) return 'contact_invalid';
  if (facts.mailboxRemoved) return 'mailbox_removed';
  if (facts.complianceBlocked) return 'compliance_blocked';
  return null;
}
