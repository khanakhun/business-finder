import type { QualityDecision, QualityGateResult, QualityIssue } from '@bf/contracts';
import { prioritize } from './issue-prioritizer.ts';

// What happens to a version after the gates (BF-045, DOMAIN §3.3: validating → repairing → validating, at most two
// repairs, otherwise needs_review). Never a silent pass: a gate that could not run sends the version to a person.

export interface DecisionInput {
  readonly gates: readonly QualityGateResult[];
  readonly repairsLeft: number;
  readonly supportsRepair: boolean;
}

export interface Decision {
  readonly decision: QualityDecision;
  /** The issues sent for repair, or left for the review. */
  readonly issues: QualityIssue[];
  readonly infraError: boolean;
  readonly reason: string;
}

export function decide(input: DecisionInput): Decision {
  const infraError = input.gates.some((gate) => gate.status === 'error');
  const errors = input.gates.flatMap((gate) => gate.issues.filter((issue) => issue.severity === 'error'));
  if (infraError)
    return {
      decision: 'needs_review',
      issues: prioritize(errors, 100),
      infraError,
      reason: `a gate could not run (${input.gates
        .filter((gate) => gate.status === 'error')
        .map((gate) => gate.id)
        .join(', ')})`,
    };
  if (errors.length === 0) return { decision: 'pass', issues: [], infraError, reason: 'every gate passed' };
  const stuck = errors.filter((issue) => !issue.repairable || issue.platform);
  if (stuck.length > 0)
    return {
      decision: 'needs_review',
      issues: prioritize(errors, 100),
      infraError,
      reason: `${stuck.length} error(s) no engine can repair${stuck.some((issue) => issue.platform) ? ' (platform)' : ''}`,
    };
  if (!input.supportsRepair)
    return {
      decision: 'needs_review',
      issues: prioritize(errors, 100),
      infraError,
      reason: 'the engine cannot repair',
    };
  if (input.repairsLeft <= 0)
    return {
      decision: 'needs_review',
      issues: prioritize(errors, 100),
      infraError,
      reason: 'no repair left',
    };
  return {
    decision: 'repair',
    issues: prioritize(errors),
    infraError,
    reason: `${errors.length} repairable error(s)`,
  };
}
