import { z } from 'zod';
import { booleanFlag, secret } from '../schema.ts';

export const authEnv = z.object({
  BETTER_AUTH_SECRET: secret(
    z.string().min(32).describe('Better Auth signing secret, ≥ 32 chars. Generate: openssl rand -base64 32'),
  ),
  SIGNUP_MODE: z
    .enum(['invite_only', 'allowlist', 'open'])
    .optional()
    .describe('Who may create an account. Default: invite_only in production, open otherwise.'),
  SIGNUP_ALLOWED_EMAIL_DOMAINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean),
    )
    .describe('Comma-separated email domains that may self-register when SIGNUP_MODE=allowlist.'),
  PLATFORM_OPERATOR_EMAILS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    )
    .describe(
      'Comma-separated verified emails allowed to use cross-workspace operator tools (Bull Board, queue smoke test).',
    ),
  AUTH_TRUSTED_PROXIES: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((proxy) => proxy.trim())
        .filter(Boolean),
    )
    .describe('Reverse-proxy IPs/CIDRs in front of the API, for client-IP detection behind X-Forwarded-For.'),
  AUTH_COOKIE_DOMAIN: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Parent domain shared by app. and api. for the session cookie (e.g. example.com). Unset = host-only.',
    ),
  AUTH_CHECK_PWNED: booleanFlag(true).describe(
    'Reject passwords found in known breaches (k-anonymity queries to api.pwnedpasswords.com).',
  ),
  GOOGLE_CLIENT_ID: z
    .string()
    .min(1)
    .optional()
    .describe('Google OAuth client id; Google sign-in is off when unset.'),
  GOOGLE_CLIENT_SECRET: secret(z.string().min(1).optional().describe('Google OAuth client secret.')),
  SECRETS_MASTER_KEY: secret(
    z
      .base64()
      .refine((value) => Buffer.from(value, 'base64').length === 32, 'Expected 32 bytes, base64-encoded')
      .describe(
        'Master key wrapping workspace secret data keys (AES-256-GCM). Generate: openssl rand -base64 32',
      ),
  ),
});
