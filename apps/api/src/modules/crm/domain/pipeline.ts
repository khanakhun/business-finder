import { InvalidStateTransitionError, type PipelineStatus, ValidationError } from '@bf/contracts';

// Pipeline state machine (BF-024, DOMAIN.md §3.1). A typed transition table: who may make each move (a person, or
// the system reacting to outreach and site leads) and whether it needs a reason.

export type Trigger = 'manual' | 'automatic';

interface Edge {
  readonly to: PipelineStatus;
  /** Who may make the move: people (UI/API) and/or the system (markContacted, markEngaged). */
  readonly by: readonly Trigger[];
}

const both = ['manual', 'automatic'] as const;
const manual = ['manual'] as const;
const automatic = ['automatic'] as const;

// DECISION(BF-024): qualified → contacted and contacted → engaged are automatic in DOMAIN.md, but partners also call
// and visit: they may make those moves by hand too. Site-lead jumps (new/qualified → engaged) stay automatic.
export const TRANSITIONS: Readonly<Record<PipelineStatus, readonly Edge[]>> = {
  new: [
    { to: 'qualified', by: manual },
    { to: 'disqualified', by: manual },
    { to: 'engaged', by: automatic },
  ],
  qualified: [
    { to: 'contacted', by: both },
    { to: 'disqualified', by: manual },
    { to: 'engaged', by: automatic },
  ],
  contacted: [
    { to: 'engaged', by: both },
    { to: 'lost', by: manual },
  ],
  engaged: [
    { to: 'meeting', by: manual },
    { to: 'lost', by: manual },
  ],
  meeting: [
    { to: 'proposal', by: manual },
    { to: 'lost', by: manual },
  ],
  proposal: [
    { to: 'won', by: manual },
    { to: 'lost', by: manual },
  ],
  won: [],
  lost: [{ to: 'qualified', by: manual }],
  disqualified: [{ to: 'new', by: manual }],
};

/** Moves that need a reason (why it was lost or disqualified). */
export const REASON_REQUIRED: ReadonlySet<PipelineStatus> = new Set(['lost', 'disqualified']);

export interface AllowedTransition {
  readonly to: PipelineStatus;
  readonly requiresReason: boolean;
}

export function allowedTransitions(from: PipelineStatus, trigger: Trigger = 'manual'): AllowedTransition[] {
  return TRANSITIONS[from]
    .filter((edge) => edge.by.includes(trigger))
    .map((edge) => ({ to: edge.to, requiresReason: REASON_REQUIRED.has(edge.to) }));
}

/** Checks a move; returns the reason to store (null when none is needed). */
export function checkTransition(
  from: PipelineStatus,
  to: PipelineStatus,
  reason: string | undefined,
  trigger: Trigger,
): string | null {
  if (!allowedTransitions(from, trigger).some((t) => t.to === to)) {
    throw new InvalidStateTransitionError('Pipeline status', from, to);
  }
  if (!REASON_REQUIRED.has(to)) return null;
  const trimmed = reason?.trim();
  if (!trimmed) {
    throw new ValidationError(`A reason is required to mark a business ${to}.`, [
      { path: ['reason'], message: 'Required' },
    ]);
  }
  return trimmed;
}
