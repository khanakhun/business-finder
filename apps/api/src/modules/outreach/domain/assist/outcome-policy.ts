import type { CallOutcome } from '@bf/contracts';

// What a call's outcome does (BF-057, policy table): deterministic CRM effects — the pipeline, a task, a suppression —
// and what the app opens next. Every outcome is also a manual contact log with its compliance decision.

export type OutcomeEffect =
  | { readonly kind: 'engaged' }
  | { readonly kind: 'task'; readonly title: string; readonly when: 'today' | 'callback' | 'tomorrow' }
  | { readonly kind: 'suppress_phone' }
  | { readonly kind: 'do_not_contact' }
  | { readonly kind: 'contact_invalid' };

export interface OutcomePolicy {
  readonly effects: readonly OutcomeEffect[];
  readonly next: 'compose' | 'whatsapp' | null;
}

export const OUTCOME_POLICY: Readonly<Record<CallOutcome, OutcomePolicy>> = {
  no_answer: { effects: [{ kind: 'task', title: 'Call again', when: 'tomorrow' }], next: null },
  voicemail: {
    effects: [{ kind: 'task', title: 'Call again after the voicemail', when: 'tomorrow' }],
    next: null,
  },
  interested: {
    effects: [{ kind: 'engaged' }, { kind: 'task', title: 'Follow up on the call', when: 'today' }],
    next: null,
  },
  not_interested: { effects: [], next: null },
  call_back: { effects: [{ kind: 'task', title: 'Call back as agreed', when: 'callback' }], next: null },
  info_email: {
    effects: [{ kind: 'task', title: 'Send the information by email', when: 'today' }],
    next: 'compose',
  },
  info_whatsapp: {
    effects: [{ kind: 'task', title: 'Send the information by WhatsApp', when: 'today' }],
    next: 'whatsapp',
  },
  wrong_number: { effects: [{ kind: 'contact_invalid' }], next: null },
  do_not_call: { effects: [{ kind: 'suppress_phone' }], next: null },
};

export function outcomeEffects(outcome: CallOutcome, doNotContact: boolean): OutcomePolicy {
  const policy = OUTCOME_POLICY[outcome];
  return outcome === 'do_not_call' && doNotContact
    ? { ...policy, effects: [...policy.effects, { kind: 'do_not_contact' }] }
    : policy;
}
