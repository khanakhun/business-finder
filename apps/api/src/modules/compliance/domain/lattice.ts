import { COMPLIANCE_DECISIONS, type ComplianceDecisionValue } from '@bf/contracts';

// The decision lattice (BF-049): allowed < allowed_with_conditions < manual_only < blocked. Combining decisions keeps
// the most restrictive one; nothing combined with `blocked` is ever less than `blocked`. Pure.

export const rank = (decision: ComplianceDecisionValue): number => COMPLIANCE_DECISIONS.indexOf(decision);

/** The most restrictive of the decisions (`allowed` for none). */
export function strictest(...decisions: readonly ComplianceDecisionValue[]): ComplianceDecisionValue {
  return decisions.reduce<ComplianceDecisionValue>(
    (worst, next) => (rank(next) > rank(worst) ? next : worst),
    'allowed',
  );
}

/** Sending can be queued (automatically or by a person in the app). */
export const isAllowed = (decision: ComplianceDecisionValue) =>
  decision === 'allowed' || decision === 'allowed_with_conditions';
