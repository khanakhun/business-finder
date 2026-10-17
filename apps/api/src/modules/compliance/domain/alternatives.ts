import type { ComplianceDecision, ComplianceDecisionValue, OutreachChannel } from '@bf/contracts';

// What a person can do instead when a channel is not allowed (BF-049): compliant alternatives, localized. Pure.

type Alternative = ComplianceDecision['alternatives'][number];

const LABELS: Record<Alternative['code'], Alternative['label']> = {
  manual_call: {
    en: 'Call the business (manual, allowed with the right to object)',
    fr: 'Appeler l’entreprise (manuellement, avec droit d’opposition)',
  },
  manual_email: {
    en: 'Send by hand from your mailbox after confirming consent',
    fr: 'Envoyer manuellement depuis votre boîte après avoir confirmé le consentement',
  },
  letter: { en: 'Send a postal letter', fr: 'Envoyer un courrier postal' },
  manual_whatsapp: {
    en: 'Write on WhatsApp by hand, identifying yourself and stopping on request',
    fr: 'Écrire sur WhatsApp manuellement, en vous identifiant et en arrêtant sur demande',
  },
};

export function alternativesFor(
  channel: OutreachChannel,
  decision: ComplianceDecisionValue,
  blockedBy: readonly string[],
): Alternative[] {
  if (decision === 'allowed' || decision === 'allowed_with_conditions') return [];
  // Nothing else is offered when the recipient objected or is marked do-not-contact.
  if (blockedBy.some((code) => code === 'overlay.suppressed' || code === 'overlay.do_not_contact')) return [];
  const codes: Alternative['code'][] = [];
  if (channel !== 'phone') codes.push('manual_call');
  if (channel === 'email' && decision === 'manual_only') codes.push('manual_email');
  if (channel !== 'letter') codes.push('letter');
  return codes.map((code) => ({ code, label: LABELS[code] }));
}
