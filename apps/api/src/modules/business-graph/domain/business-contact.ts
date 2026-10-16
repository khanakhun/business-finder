import type { ContactType, SourceProvider } from '@bf/contracts';
import { InvalidValueError } from './errors.ts';
import { EmailAddress } from './value-objects/email-address.ts';
import { PhoneNumber } from './value-objects/phone-number.ts';
import { WebsiteUrl } from './value-objects/website-url.ts';

export interface BusinessContactProps {
  readonly id: string;
  readonly businessId: string;
  readonly type: ContactType;
  readonly value: string;
  /** Unique per business and type (E.164, lowercase email, canonical URL). */
  readonly normalizedValue: string;
  readonly subtype: string;
  readonly personName: string | null;
  readonly source: SourceProvider;
  readonly sourceUrl: string | null;
  readonly publishedOnSite: boolean;
  readonly confidence: number;
  /** The workspace that added a manual contact (attribution only, never shown to other workspaces). */
  readonly submittedByOrgId: string | null;
}

/** Social networks accepted as `social` contacts (registrable domain → network name). */
const SOCIAL_NETWORKS = new Map([
  ['facebook.com', 'facebook'],
  ['instagram.com', 'instagram'],
  ['linkedin.com', 'linkedin'],
  ['x.com', 'x'],
  ['twitter.com', 'x'],
  ['tiktok.com', 'tiktok'],
  ['youtube.com', 'youtube'],
  ['pinterest.com', 'pinterest'],
  ['threads.net', 'threads'],
]);

/** Paths of personal profiles on those networks (matched against `<domain><path>`). */
const PERSONAL_PROFILE_PATHS = [/^linkedin\.com\/(in|pub)\//i, /^facebook\.com\/(profile\.php|people\/)/i];

/** Normalizes a raw contact value by type; invalid values throw `InvalidValueError`. */
export function normalizeContact(
  type: ContactType,
  raw: string,
  regionHint: string | null,
): { normalizedValue: string; subtype: string } {
  switch (type) {
    case 'email': {
      const email = EmailAddress.parse(raw);
      return { normalizedValue: email.value, subtype: email.subtype };
    }
    case 'phone':
    case 'whatsapp': {
      const phone = PhoneNumber.parse(raw, regionHint ?? undefined);
      return { normalizedValue: phone.e164, subtype: phone.type };
    }
    case 'website_form': {
      return { normalizedValue: WebsiteUrl.parse(raw).canonical, subtype: 'unknown' };
    }
    case 'social': {
      const url = WebsiteUrl.parse(raw);
      const network = SOCIAL_NETWORKS.get(url.registrableDomain);
      const path = new URL(url.canonical).pathname;
      if (!network || path === '/')
        throw new InvalidValueError('social', 'Not a business social profile address.');
      // Data minimization (security.md §7): business pages only, never a person's profile.
      if (PERSONAL_PROFILE_PATHS.some((pattern) => pattern.test(`${url.registrableDomain}${path}`))) {
        throw new InvalidValueError('social', 'Personal profiles are not stored; use the business page.');
      }
      return { normalizedValue: url.canonical, subtype: network };
    }
  }
}
