import type {
  ComplianceDecisionValue,
  DecisionReason,
  EvaluationInputs,
  PolicyCondition,
  PolicyDocument,
  RequiredElement,
} from '@bf/contracts';
import { strictest } from './lattice.ts';
import { overlays } from './overlays.ts';

// The policy evaluation (BF-049), a pure function: for each candidate jurisdiction, its seed policy (and the
// workspace's stricter override) gives a decision by the first matching rule; then the global overlays (suppression,
// do-not-contact, markers, invalid address, workspace identity, lawful basis). The most restrictive result wins, and
// every step says why (EN/FR).

export interface EvaluablePolicy {
  readonly versionId: string;
  readonly jurisdiction: string;
  readonly policy: PolicyDocument;
}

export interface PolicySet {
  readonly seed: EvaluablePolicy;
  /** The workspace's override (stricter only; merged by taking the more restrictive result). */
  readonly override?: EvaluablePolicy | undefined;
}

export interface Evaluation {
  readonly decision: ComplianceDecisionValue;
  readonly reasons: DecisionReason[];
  readonly requiredElements: RequiredElement[];
  readonly policyVersionIds: string[];
}

/** Whether a rule's conditions hold for the inputs (keys absent from the rule match anything). */
export function matches(when: PolicyCondition, inputs: EvaluationInputs): boolean {
  const checks: [readonly string[] | undefined, string][] = [
    [when.recipientType, inputs.recipientType],
    [when.addressType, inputs.addressType],
    [when.publishedContext, inputs.publishedContext],
    [when.designatedForSolicitation, inputs.designatedForSolicitation],
    [when.relevance, inputs.relevance],
    [when.previousContact, inputs.previousContact],
  ];
  return checks.every(([allowed, value]) => allowed === undefined || allowed.includes(value));
}

/** One policy's decision: its first matching rule, else its default. */
export function decide(
  policy: EvaluablePolicy,
  inputs: EvaluationInputs,
): { decision: ComplianceDecisionValue; reason: DecisionReason } {
  const rule = policy.policy.rules.find((candidate) => matches(candidate.when, inputs));
  return rule
    ? {
        decision: rule.decision,
        reason: {
          code: `policy.${rule.id}`,
          message: rule.explain,
          ruleRef: `${policy.jurisdiction}:${rule.id}`,
        },
      }
    : {
        decision: policy.policy.default,
        reason: {
          code: 'policy.default',
          message: policy.policy.defaultExplain,
          ruleRef: `${policy.jurisdiction}:default`,
        },
      };
}

/**
 * The decision for the inputs under the candidate jurisdictions' policies (conflicting signals: every candidate is
 * evaluated and the stricter wins) and the overlays.
 */
export function evaluatePolicy(sets: readonly PolicySet[], inputs: EvaluationInputs): Evaluation {
  if (sets.length === 0) throw new Error('No policy to evaluate');
  const decisions: ComplianceDecisionValue[] = [];
  const reasons: DecisionReason[] = [];
  const elements = new Set<RequiredElement>();
  const versions: string[] = [];
  for (const set of sets) {
    const seed = decide(set.seed, inputs);
    versions.push(set.seed.versionId);
    for (const element of set.seed.policy.requiredElements) elements.add(element);
    let decision = seed.decision;
    reasons.push(seed.reason);
    if (set.override) {
      const override = decide(set.override, inputs);
      versions.push(set.override.versionId);
      for (const element of set.override.policy.requiredElements) elements.add(element);
      // Stricter only: an override can never loosen its seed.
      if (strictest(seed.decision, override.decision) !== seed.decision) {
        decision = override.decision;
        reasons.push({ ...override.reason, code: `override.${override.reason.code}` });
      }
    }
    decisions.push(decision);
  }
  for (const overlay of overlays(inputs)) {
    decisions.push(overlay.decision);
    reasons.push(overlay.reason);
  }
  const decision = strictest(...decisions);
  // The reasons that decided first (the most restrictive), then the others.
  return {
    decision,
    reasons: reasons
      .slice()
      .sort((a, b) => Number(b.code.startsWith('overlay.')) - Number(a.code.startsWith('overlay.'))),
    requiredElements: [...elements],
    policyVersionIds: versions,
  };
}
