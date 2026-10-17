// What a reply sets in motion (BF-054, deterministic): the always-safe actions happen for any human reply; the
// others depend on the triage, and only when it is confident and not suspected of prompt injection. Unsubscribe is
// decided by the keyword detector or a fairly confident class — favouring suppression.

import type { TriageClass } from '@bf/contracts';

export type ReplyAction =
  | { readonly kind: 'notify'; readonly priority: 'high' | 'normal' }
  | { readonly kind: 'suppress' }
  | { readonly kind: 'pipeline_engaged' }
  | { readonly kind: 'task_reply' }
  | { readonly kind: 'task_follow_up'; readonly inMonths: number; readonly on: string | null }
  | { readonly kind: 'task_referral' }
  | { readonly kind: 'suggest_lost' }
  | { readonly kind: 'suggest_reply' }
  | { readonly kind: 'reschedule_sequences'; readonly until: string | null };

export interface PolicyInput {
  readonly kind: 'human' | 'auto_reply' | 'bounce' | 'unsubscribe_mailto';
  readonly unsubscribeDetected: boolean;
  readonly triage: {
    readonly class: TriageClass;
    readonly confidence: number;
    readonly injectionSuspected: boolean;
    readonly followUpOn: string | null;
  } | null;
  readonly autoReplyUntil: string | null;
}

export const CONFIDENT = 0.7;
export const UNSUBSCRIBE_CONFIDENCE = 0.5;

export function replyActions(input: PolicyInput): ReplyAction[] {
  if (input.kind === 'bounce') return [];
  if (input.kind === 'unsubscribe_mailto') return [{ kind: 'suppress' }];
  if (input.kind === 'auto_reply') return [{ kind: 'reschedule_sequences', until: input.autoReplyUntil }];
  const triage = input.triage;
  const unsubscribe =
    input.unsubscribeDetected ||
    (triage?.class === 'unsubscribe' && triage.confidence >= UNSUBSCRIBE_CONFIDENCE);
  if (unsubscribe) return [{ kind: 'suppress' }, { kind: 'notify', priority: 'normal' }];
  const confident = triage !== null && triage.confidence >= CONFIDENT && !triage.injectionSuspected;
  if (!triage || !confident) return [{ kind: 'notify', priority: 'normal' }];
  switch (triage.class) {
    case 'interested':
    case 'question':
      return [
        { kind: 'notify', priority: 'high' },
        { kind: 'pipeline_engaged' },
        { kind: 'task_reply' },
        { kind: 'suggest_reply' },
      ];
    case 'not_now':
      return [
        { kind: 'notify', priority: 'normal' },
        { kind: 'task_follow_up', inMonths: 3, on: triage.followUpOn },
      ];
    case 'referral':
      return [{ kind: 'notify', priority: 'normal' }, { kind: 'task_referral' }];
    case 'negative':
      return [{ kind: 'notify', priority: 'normal' }, { kind: 'suggest_lost' }];
    case 'auto_reply':
      return [{ kind: 'reschedule_sequences', until: input.autoReplyUntil ?? triage.followUpOn }];
    default:
      return [{ kind: 'notify', priority: 'normal' }];
  }
}
