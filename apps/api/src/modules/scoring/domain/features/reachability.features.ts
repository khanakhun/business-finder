import type { FeatureComputes } from './feature.ts';

// Reachability features (BF-028 verification): can the workspace reach the business, and how well.

/** Addresses worth writing to (an invalid or disposable one is not a way in). */
const USABLE = new Set(['valid', 'catch_all', 'risky', 'unknown']);

export const reachabilityFeatures: FeatureComputes = {
  has_verified_email: (facts) => facts.contacts.emails.some((email) => email.status === 'valid'),
  has_generic_email_only: (facts) => {
    const usable = facts.contacts.emails.filter((email) => USABLE.has(email.status));
    return usable.length > 0 && usable.every((email) => email.generic);
  },
  has_phone: (facts) => facts.contacts.phones > 0,
  has_whatsapp: (facts) => facts.contacts.whatsapp > 0,
};
