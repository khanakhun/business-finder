import { z } from 'zod';
import { secret } from '../schema.ts';

const cap = (fallback: number, what: string) =>
  z.coerce.number().int().min(1).max(10_000).default(fallback).describe(what);

// Outreach mailboxes (BF-050): provider-safe caps, throttles and the development SMTP path (Mailpit).
export const outreachEnv = z.object({
  MAILBOX_MAX_DAILY_CAP_GMAIL: cap(500, 'Highest daily cap a Gmail/Workspace mailbox may be set to.'),
  MAILBOX_MAX_DAILY_CAP_GRAPH: cap(500, 'Highest daily cap a Microsoft 365 mailbox may be set to.'),
  MAILBOX_MAX_DAILY_CAP_SMTP: cap(300, 'Highest daily cap an SMTP/IMAP mailbox may be set to.'),
  OUTREACH_WORKSPACE_DAILY_CAP: cap(300, 'Messages a workspace may send per day across all its mailboxes.'),
  OUTREACH_DOMAIN_HOURLY_LIMIT: cap(3, 'Messages per hour to one recipient domain, per workspace.'),
  OUTREACH_UNDO_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(600)
    .default(10)
    .describe('Seconds a sent email waits in the queue so the sender can undo it (BF-052).'),
  OUTREACH_SYNC_POLL_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3600)
    .default(120)
    .describe('Seconds between two polls of a mailbox for replies (BF-054); push notifications come on top.'),
  MAILBOX_SMTP_INSECURE_HOSTS: z
    .string()
    .default('localhost,127.0.0.1,::1,mailpit')
    .transform((value) =>
      value
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    )
    .describe(
      'Comma-separated SMTP/IMAP hosts allowed without TLS (Mailpit in development and E2E). Ignored in production.',
    ),
  MAILBOX_HEALTH_SEED_ADDRESS: z
    .email()
    .optional()
    .describe('Address the optional weekly send test goes to; unset, the weekly test is off.'),
  GOOGLE_OAUTH_CLIENT_ID: z
    .string()
    .min(1)
    .optional()
    .describe(
      'OAuth client of the Google Cloud project (type Web, user type Internal to the Workspace) for Gmail mailboxes.',
    ),
  GOOGLE_OAUTH_CLIENT_SECRET: secret(
    z.string().min(1).optional().describe('Secret of GOOGLE_OAUTH_CLIENT_ID.'),
  ),
  MICROSOFT_OAUTH_CLIENT_ID: z
    .string()
    .min(1)
    .optional()
    .describe('Application (client) id of the Entra ID app registration for Microsoft 365 mailboxes.'),
  MICROSOFT_OAUTH_CLIENT_SECRET: secret(
    z.string().min(1).optional().describe('Client secret of MICROSOFT_OAUTH_CLIENT_ID.'),
  ),
  MICROSOFT_OAUTH_TENANT: z
    .string()
    .min(1)
    .default('organizations')
    .describe('Entra ID tenant id, or `organizations` (any work account) / `common`.'),
  UNSUBSCRIBE_BASE_URL: z
    .url()
    .optional()
    .describe(
      'Public HTTPS origin of the unsubscribe links (e.g. https://u.example.com routed to the API); defaults to API_URL.',
    ),
  SPAMHAUS_DQS_KEY: secret(
    z
      .string()
      .regex(/^[a-z0-9]{20,40}$/)
      .optional()
      .describe(
        'Spamhaus Data Query Service key for the optional blocklist checks (BF-056). Unset: blocklist checks are off. Spamhaus forbids queries through public resolvers and limits free use to low-volume, non-commercial users; commercial use needs a subscription (spamhaus.com/data-access).',
      ),
  ),
  PRIVACY_HASH_PEPPER: secret(
    z
      .string()
      .min(32)
      .optional()
      .describe(
        'Pepper of the keyed hashes kept instead of erased addresses (BF-055). Never rotate it: hashed suppressions would stop matching. Defaults to one derived from BETTER_AUTH_SECRET.',
      ),
  ),
});
