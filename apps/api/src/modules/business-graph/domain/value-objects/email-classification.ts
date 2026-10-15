import { getDomain } from 'tldts';
import { DISPOSABLE_DOMAINS } from './disposable-domains.data.ts';
import type { EmailAddress, EmailSubtype } from './email-address.ts';

// E-mail classification (BF-028): what an address says about itself, before any mailbox check. Outreach rules
// (BF-049) differ for personal, webmail and disposable addresses and for addresses on the business's own domain.

/** Free webmail domains (data file: extend when a market needs it). Exact match on the address's domain. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  // International
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.fr',
  'hotmail.com',
  'hotmail.fr',
  'hotmail.co.uk',
  'live.com',
  'live.fr',
  'msn.com',
  'yahoo.com',
  'yahoo.fr',
  'yahoo.co.uk',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'aol.fr',
  'gmx.com',
  'gmx.fr',
  'gmx.de',
  'gmx.net',
  'mail.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'zoho.com',
  'yandex.com',
  'tutanota.com',
  'fastmail.com',
  // France and its overseas territories (Saint-Barthélemy, Antilles)
  'orange.fr',
  'wanadoo.fr',
  'laposte.net',
  'free.fr',
  'sfr.fr',
  'neuf.fr',
  'bbox.fr',
  'numericable.fr',
  'club-internet.fr',
  'aliceadsl.fr',
  'cegetel.net',
  'voila.fr',
  'caramail.com',
  'outremer-telecom.fr',
  'canl.nc',
  'mediaserv.net',
  // United States and the Caribbean
  'comcast.net',
  'att.net',
  'verizon.net',
  'sbcglobal.net',
  'bellsouth.net',
  'cox.net',
  'earthlink.net',
  'charter.net',
  'caribsurf.com',
  'candw.ag',
  // Elsewhere in Europe
  'web.de',
  't-online.de',
  'libero.it',
  'virgilio.it',
  'tiscali.it',
  'btinternet.com',
  'sky.com',
  'telenet.be',
  'skynet.be',
  'bluewin.ch',
  'ziggo.nl',
  'kpnmail.nl',
]);

let disposable: ReadonlySet<string> | undefined;
const disposableDomains = (): ReadonlySet<string> => {
  disposable ??= new Set(DISPOSABLE_DOMAINS.split('\n'));
  return disposable;
};

/** A throw-away mailbox domain (or a subdomain of one). */
export function isDisposableDomain(domain: string): boolean {
  const labels = domain.toLowerCase().split('.');
  const set = disposableDomains();
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (set.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

export const isFreeMailDomain = (domain: string): boolean => FREE_MAIL_DOMAINS.has(domain.toLowerCase());

/**
 * Whether the address is on the business's own domain (`contact@salon-ondine.fr` for `www.salon-ondine.fr`): same
 * registrable domain. Null when there is no website to compare with.
 */
export function matchesWebsiteDomain(
  emailDomain: string,
  websiteHost: string | null | undefined,
): boolean | null {
  if (!websiteHost) return null;
  const site = getDomain(websiteHost);
  const mail = getDomain(emailDomain);
  if (!site || !mail) return null;
  return site === mail;
}

export interface EmailClassification {
  readonly subtype: EmailSubtype;
  /** A shared mailbox (generic or department), not a person's. */
  readonly isRoleAccount: boolean;
  readonly isFreeMail: boolean;
  readonly isDisposable: boolean;
  readonly matchesWebsiteDomain: boolean | null;
}

/** Classifies a parsed address, optionally against the business's website host. */
export function classifyEmail(email: EmailAddress, websiteHost?: string | null): EmailClassification {
  return {
    subtype: email.subtype,
    isRoleAccount: email.subtype === 'generic' || email.subtype === 'department',
    isFreeMail: isFreeMailDomain(email.domain),
    isDisposable: isDisposableDomain(email.domain),
    matchesWebsiteDomain: matchesWebsiteDomain(email.domain, websiteHost),
  };
}
