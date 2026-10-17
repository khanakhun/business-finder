import type { EmailLocale } from '@bf/contracts';

// Which language to write to a recipient in (BF-051, Strategy): the contact's language, then the business site's
// primary language, then the jurisdiction's default (FR, BL, MF and the French overseas → French; US, GB → English),
// then the workspace's default.

const FRENCH = new Set([
  'FR',
  'BL',
  'MF',
  'GP',
  'MQ',
  'GF',
  'RE',
  'YT',
  'PM',
  'WF',
  'PF',
  'NC',
  'MC',
  'BE',
  'LU',
]);

const asLocale = (value: string | null | undefined): EmailLocale | null => {
  const lower = value?.trim().toLowerCase().slice(0, 2);
  return lower === 'fr' || lower === 'en' ? lower : null;
};

export interface LanguageInputs {
  readonly contactLocale?: string | null;
  readonly siteLanguage?: string | null;
  readonly countryCode?: string | null;
  readonly workspaceLocale: string;
}

export function recipientLanguage(input: LanguageInputs): {
  readonly locale: EmailLocale;
  readonly reason: string;
} {
  const contact = asLocale(input.contactLocale);
  if (contact) return { locale: contact, reason: 'contact' };
  const site = asLocale(input.siteLanguage);
  if (site) return { locale: site, reason: 'website' };
  const country = input.countryCode?.toUpperCase();
  if (country && FRENCH.has(country)) return { locale: 'fr', reason: 'jurisdiction' };
  if (country === 'US' || country === 'GB') return { locale: 'en', reason: 'jurisdiction' };
  return { locale: asLocale(input.workspaceLocale) ?? 'en', reason: 'workspace' };
}
