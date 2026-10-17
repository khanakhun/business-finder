import type { SuppressionScope } from '@bf/contracts';
import { getDomain } from 'tldts';

// Suppression keys, normalized the same way when stored and when looked up (BF-049): emails lowercased and taken
// literally (no Gmail dot folding), domains reduced to their registrable domain (public suffix list), phones E.164
// digits with their +, business ids as given. Null when the value is not a valid key. Pure.

export function normalizeKey(scope: SuppressionScope, value: string): string | null {
  const raw = value.trim();
  switch (scope) {
    case 'email': {
      const email = raw.toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
    }
    case 'domain': {
      const host =
        raw
          .toLowerCase()
          .replace(/^[a-z]+:\/\//, '')
          .split(/[/@]/)
          .pop() ?? '';
      return getDomain(host) ?? null;
    }
    case 'phone': {
      const digits = raw.replace(/[\s().-]/g, '');
      return /^\+\d{6,15}$/.test(digits) ? digits : null;
    }
    case 'business':
    case 'org_business':
      return /^[0-9a-f-]{36}$/i.test(raw) ? raw.toLowerCase() : null;
  }
}

/** The domain of an email (for a domain-scope lookup). */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at > 0 ? normalizeKey('domain', email.slice(at + 1)) : null;
}
