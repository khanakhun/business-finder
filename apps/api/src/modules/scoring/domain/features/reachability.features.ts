import type { FeatureComputes } from './feature.ts';

// Reachability features (BF-028 verification): can the workspace reach the business, and how well.

/** Addresses worth writing to (an invalid or disposable one is not a way in). */
const USABLE = new Set(['valid', 'catch_all', 'risky', 'unknown']);

const usable = (facts: Parameters<NonNullable<FeatureComputes['has_phone']>>[0]) =>
  facts.contacts.emails.filter((email) => USABLE.has(email.status));

export const reachabilityFeatures: FeatureComputes = {
  has_verified_email: (facts) => facts.contacts.emails.some((email) => email.status === 'valid'),
  has_usable_email: (facts) => usable(facts).length > 0,
  // Unknown without a usable e-mail (neither "generic only" nor "a personal one is known").
  has_generic_email_only: (facts) => {
    const emails = usable(facts);
    return emails.length > 0 ? emails.every((email) => email.generic) : null;
  },
  has_phone: (facts) => facts.contacts.phones > 0,
  has_whatsapp: (facts) => facts.contacts.whatsapp > 0,
};
