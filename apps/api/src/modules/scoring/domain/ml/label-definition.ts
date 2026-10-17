// The outcome label (BF-059, versioned): what counts as success after a first contact. The unit is a workspace's
// first contact with a business for an offer at `t0`. Positive when, within the horizon after `t0`, the business
// replied interested or with a question, left a lead on its preview, or reached `engaged` or a later stage.
// Negative when contacted and none of that happened. Censored (left out) while `t0 + horizon` is still ahead.
// A first email that bounced is left out: it says nothing about the market.

export interface LabelDefinition {
  readonly version: number;
  readonly horizonDays: number;
  readonly positiveReplyClasses: readonly string[];
  readonly positiveStages: readonly string[];
  readonly leadKinds: readonly string[];
}

export const LABEL_DEFINITIONS: Readonly<Record<number, LabelDefinition>> = {
  1: {
    version: 1,
    horizonDays: 30,
    positiveReplyClasses: ['interested', 'question'],
    positiveStages: ['engaged', 'meeting', 'proposal', 'won'],
    leadKinds: ['claim_interest', 'contact_request'],
  },
};
export const CURRENT_LABEL_VERSION = 1;

/** What happened to a contacted business (from the analytics facts). */
export interface ContactHistory {
  readonly firstContactAt: Date;
  readonly bounced: boolean;
  readonly events: readonly {
    readonly at: Date;
    readonly kind: 'reply' | 'lead' | 'stage';
    readonly value: string;
  }[];
}

export type Label = 'positive' | 'negative' | 'censored' | 'excluded';

export function labelOf(history: ContactHistory, definition: LabelDefinition, now: Date): Label {
  if (history.bounced) return 'excluded';
  const end = history.firstContactAt.getTime() + definition.horizonDays * 86_400_000;
  const positive = history.events.some((event) => {
    const at = event.at.getTime();
    if (at < history.firstContactAt.getTime() || at > end) return false;
    if (event.kind === 'reply') return definition.positiveReplyClasses.includes(event.value);
    if (event.kind === 'lead') return definition.leadKinds.includes(event.value);
    return definition.positiveStages.includes(event.value);
  });
  // A success inside the horizon is known even before the horizon ends; a failure is not.
  if (positive) return 'positive';
  return end > now.getTime() ? 'censored' : 'negative';
}
