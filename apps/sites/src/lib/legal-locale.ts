import { LEGAL_EN, LEGAL_FR, type LegalStrings } from './legal-strings.ts';

/** The legal pages' texts in a site language (French, else English). */
export const legalStrings = (locale: string): LegalStrings => (locale === 'fr' ? LEGAL_FR : LEGAL_EN);
