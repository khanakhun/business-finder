import { type ComplianceDecision, DomainError, type ProblemDetails } from '@bf/contracts';

/** The compliance gate refused a send: manual-only → 409 (send it yourself, log it), blocked → 422. */
export class ComplianceRefusedError extends DomainError {
  readonly code;

  constructor(
    readonly decision: ComplianceDecision,
    channel = 'email',
  ) {
    super(
      decision.decision === 'manual_only'
        ? 'This contact may only be reached by hand: copy the email and log the contact.'
        : channel === 'email'
          ? 'This contact may not be emailed.'
          : `This contact may not be reached by ${channel}.`,
      { details: { reason: decision.decision === 'manual_only' ? 'MANUAL_ONLY' : 'BLOCKED' } },
    );
    this.code = decision.decision === 'manual_only' ? ('CONFLICT' as const) : ('VALIDATION_FAILED' as const);
  }

  override toProblem(instance?: string, traceId?: string): ProblemDetails {
    return {
      ...super.toProblem(instance, traceId),
      refusal: {
        decision: this.decision.decision === 'manual_only' ? 'manual_only' : 'blocked',
        decisionId: this.decision.id,
        reasons: this.decision.reasons.map((reason) => ({ code: reason.code, message: reason.message.en })),
        alternatives: this.decision.alternatives.map((alternative) => alternative.code),
      },
    };
  }
}

/** The draft cannot go out as it is (lint errors, no recipient address, no postal address…). */
export class MessageNotSendableError extends DomainError {
  readonly code = 'VALIDATION_FAILED';

  constructor(message: string, reason: string) {
    super(message, { details: { reason } });
  }
}
