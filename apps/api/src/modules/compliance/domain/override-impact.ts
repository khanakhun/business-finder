import {
  ADDRESS_TYPES,
  type EvaluationInputs,
  type PolicyDocument,
  PREVIOUS_CONTACTS,
  PUBLISHED_CONTEXTS,
  RECIPIENT_TYPES,
  RELEVANCES,
  TRI_STATES,
} from '@bf/contracts';
import { rank } from './lattice.ts';
import { decide } from './policy-evaluator.ts';

// What a workspace override changes (BF-049), pure: every combination of the conditions a rule can test is decided by
// the seed and by the override; the merge keeps the stricter, so an override can only tighten. The count of
// combinations it tightens is the impact preview shown before saving.

export function overrideImpact(
  seed: PolicyDocument,
  override: PolicyDocument,
): { combinations: number; stricter: number } {
  let combinations = 0;
  let stricter = 0;
  const base = {
    jurisdictions: ['*'],
    channel: 'email',
    suppressed: false,
    doNotContact: false,
    noSolicitationMarker: false,
    addressInvalid: false,
    workspaceReady: true,
    lawfulBasisApproved: true,
  } as const;
  for (const recipientType of RECIPIENT_TYPES)
    for (const addressType of ADDRESS_TYPES)
      for (const publishedContext of PUBLISHED_CONTEXTS)
        for (const designatedForSolicitation of TRI_STATES)
          for (const relevance of RELEVANCES)
            for (const previousContact of PREVIOUS_CONTACTS) {
              const inputs: EvaluationInputs = {
                ...base,
                jurisdictions: [...base.jurisdictions],
                recipientType,
                addressType,
                publishedContext,
                designatedForSolicitation,
                relevance,
                previousContact,
              };
              combinations++;
              const a = decide({ versionId: 'seed', jurisdiction: '*', policy: seed }, inputs).decision;
              const b = decide(
                { versionId: 'override', jurisdiction: '*', policy: override },
                inputs,
              ).decision;
              if (rank(b) > rank(a)) stricter++;
            }
  return { combinations, stricter };
}
