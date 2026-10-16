import { InvalidValueError } from '../errors.ts';

export type EmailSubtype = 'generic' | 'personal' | 'department' | 'unknown';

/** Mailboxes for the business as a whole (outreach rules differ for personal addresses). */
const GENERIC = new Set([
  'info',
  'infos',
  'information',
  'contact',
  'contacts',
  'hello',
  'hi',
  'bonjour',
  'salut',
  'reservation',
  'reservations',
  'resa',
  'booking',
  'bookings',
  'book',
  'sales',
  'vente',
  'ventes',
  'admin',
  'office',
  'team',
  'equipe',
  'support',
  'service',
  'accueil',
  'reception',
  'mail',
  'email',
  'enquiries',
  'inquiries',
  'welcome',
  'commande',
  'commandes',
  'orders',
  'shop',
  'boutique',
  'restaurant',
  'hotel',
  'villa',
  'villas',
  'rental',
  'location',
  'locations',
  'concierge',
  'conciergerie',
  'noreply',
  'no-reply',
]);
const DEPARTMENT = new Set([
  'compta',
  'comptabilite',
  'accounting',
  'accounts',
  'billing',
  'facturation',
  'invoices',
  'rh',
  'hr',
  'jobs',
  'careers',
  'recrutement',
  'emploi',
  'marketing',
  'press',
  'presse',
  'media',
  'legal',
  'juridique',
  'it',
  'tech',
  'direction',
  'management',
]);

const SYNTAX =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export class EmailAddress {
  private constructor(
    readonly value: string,
    readonly localPart: string,
    readonly domain: string,
    readonly subtype: EmailSubtype,
  ) {}

  static parse(raw: string): EmailAddress {
    const value = raw
      .trim()
      .replace(/^mailto:/i, '')
      .toLowerCase();
    if (value.length > 254 || !SYNTAX.test(value))
      throw new InvalidValueError('email', 'Not an email address.');
    const [localPart = '', domain = ''] = value.split('@');
    if (
      localPart.length > 64 ||
      localPart.startsWith('.') ||
      localPart.endsWith('.') ||
      localPart.includes('..')
    ) {
      throw new InvalidValueError('email', 'Not an email address.');
    }
    return new EmailAddress(value, localPart, domain, EmailAddress.classify(localPart));
  }

  /** `info@` → generic, `compta@` → department, `jean.dupont@` → personal, anything else → unknown. */
  private static classify(localPart: string): EmailSubtype {
    const base = localPart.split('+')[0]?.replace(/\d+$/, '') ?? '';
    if (GENERIC.has(base)) return 'generic';
    if (DEPARTMENT.has(base)) return 'department';
    if (/^[a-z]{2,}[._-][a-z]{2,}$/.test(base)) return 'personal';
    return 'unknown';
  }

  toString(): string {
    return this.value;
  }
}
