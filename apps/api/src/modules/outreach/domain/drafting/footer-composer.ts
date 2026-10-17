import type { RequiredElement } from '@bf/contracts';

// The compliance footer (BF-051, shared kernel): composed deterministically from the compliance decision's required
// elements and the workspace identity — never written by a model or a template. The preview and the send (BF-052)
// use this same function, so what the person previews is what goes out. Email always carries the sender's identity
// and a working opt-out, whatever the policy lists.

export interface FooterInput {
  readonly locale: 'en' | 'fr';
  readonly requiredElements: readonly RequiredElement[];
  readonly agencyName: string;
  readonly legalName: string | null;
  readonly postalAddress: string | null;
  readonly unsubscribeUrl: string;
  /** Where the address was found, e.g. "your website" (the contact's published context). */
  readonly source: 'own_contact_page' | 'own_site_other' | 'directory' | 'unknown';
}

const TEXT = {
  en: {
    sender: (agency: string, legal: string | null) =>
      legal && legal !== agency ? `${agency} (${legal})` : agency,
    source: {
      own_contact_page: 'We found your address on your website’s contact page.',
      own_site_other: 'We found your address on your website.',
      directory: 'We found your address in a public business directory.',
      unknown: 'We found your address in public business information.',
    },
    optOut: (url: string) => `Don’t want to hear from us? Unsubscribe in one click: ${url}`,
    sentBy: 'Sent by',
  },
  fr: {
    sender: (agency: string, legal: string | null) =>
      legal && legal !== agency ? `${agency} (${legal})` : agency,
    source: {
      own_contact_page: 'Nous avons trouvé votre adresse sur la page contact de votre site.',
      own_site_other: 'Nous avons trouvé votre adresse sur votre site.',
      directory: 'Nous avons trouvé votre adresse dans un annuaire professionnel public.',
      unknown: 'Nous avons trouvé votre adresse dans des informations professionnelles publiques.',
    },
    optOut: (url: string) =>
      `Vous ne souhaitez plus recevoir nos messages ? Désinscription en un clic : ${url}`,
    sentBy: 'Envoyé par',
  },
} as const;

/** The footer's lines, in order. */
export function composeFooter(input: FooterInput): string[] {
  const t = TEXT[input.locale];
  const lines = [`${t.sentBy} ${t.sender(input.agencyName, input.legalName)}`];
  // A postal address is shown whenever known (CAN-SPAM requires one; harmless elsewhere).
  if (input.postalAddress) lines.push(input.postalAddress);
  if (input.requiredElements.includes('source_disclosure')) lines.push(t.source[input.source]);
  lines.push(t.optOut(input.unsubscribeUrl));
  return lines;
}
