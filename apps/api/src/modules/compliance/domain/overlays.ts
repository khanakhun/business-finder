import type { ComplianceDecisionValue, DecisionReason, EvaluationInputs } from '@bf/contracts';

// Global overlays (BF-049), applied after the jurisdiction's rule whatever the jurisdiction: each one that holds adds
// its decision; the most restrictive result wins. Pure.

export interface Overlay {
  readonly decision: ComplianceDecisionValue;
  readonly reason: DecisionReason;
}

const reason = (code: string, en: string, fr: string): DecisionReason => ({
  code: `overlay.${code}`,
  message: { en, fr },
  ruleRef: null,
});

const AUTOMATED = new Set(['email', 'sms', 'whatsapp']);

export function overlays(inputs: EvaluationInputs): Overlay[] {
  const out: Overlay[] = [];
  if (inputs.suppressed)
    out.push({
      decision: 'blocked',
      reason: reason(
        'suppressed',
        'This recipient is on the suppression list (they unsubscribed or objected).',
        'Ce destinataire est sur la liste d’exclusion (désinscription ou opposition).',
      ),
    });
  if (inputs.doNotContact)
    out.push({
      decision: 'blocked',
      reason: reason(
        'do_not_contact',
        'The business is marked “do not contact”.',
        'L’entreprise est marquée « ne pas contacter ».',
      ),
    });
  if (inputs.noSolicitationMarker)
    out.push(
      AUTOMATED.has(inputs.channel)
        ? {
            decision: 'blocked',
            reason: reason(
              'no_solicitation',
              'The business’s website says it does not want solicitation.',
              'Le site de l’entreprise indique qu’elle ne souhaite pas être démarchée.',
            ),
          }
        : {
            decision: 'manual_only',
            reason: reason(
              'no_solicitation',
              'The business’s website says it does not want solicitation: contact only by hand, and respect a refusal.',
              'Le site de l’entreprise refuse le démarchage : contact manuel uniquement, en respectant un refus.',
            ),
          },
    );
  if (inputs.addressInvalid && inputs.channel === 'email')
    out.push({
      decision: 'blocked',
      reason: reason(
        'address_invalid',
        'The email address is invalid or disposable.',
        'L’adresse e-mail est invalide ou jetable.',
      ),
    });
  if (inputs.relevance === 'not_relevant')
    out.push({
      decision: 'blocked',
      reason: reason(
        'not_relevant',
        'The offer is not relevant to this business’s activity.',
        'L’offre ne concerne pas l’activité de cette entreprise.',
      ),
    });
  if (
    !inputs.workspaceReady &&
    (inputs.channel === 'email' || inputs.channel === 'letter' || inputs.channel === 'sms')
  )
    out.push({
      decision: 'blocked',
      reason: reason(
        'workspace_identity',
        'Complete the workspace identity (agency name and postal address) before sending.',
        'Complétez l’identité de l’espace (nom de l’agence et adresse postale) avant d’envoyer.',
      ),
    });
  if (!inputs.lawfulBasisApproved)
    out.push({
      decision: 'manual_only',
      reason: reason(
        'lawful_basis',
        'No approved lawful-basis record for this purpose: approve one in Settings → Compliance.',
        'Aucune base légale approuvée pour cette finalité : approuvez-en une dans Paramètres → Conformité.',
      ),
    });
  return out;
}
