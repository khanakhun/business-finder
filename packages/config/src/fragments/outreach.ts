import { z } from 'zod';

const cap = (fallback: number, what: string) =>
  z.coerce.number().int().min(1).max(10_000).default(fallback).describe(what);

// Outreach mailboxes (BF-050): provider-safe caps, throttles and the development SMTP path (Mailpit).
export const outreachEnv = z.object({
  MAILBOX_MAX_DAILY_CAP_GMAIL: cap(500, 'Highest daily cap a Gmail/Workspace mailbox may be set to.'),
  MAILBOX_MAX_DAILY_CAP_GRAPH: cap(500, 'Highest daily cap a Microsoft 365 mailbox may be set to.'),
  MAILBOX_MAX_DAILY_CAP_SMTP: cap(300, 'Highest daily cap an SMTP/IMAP mailbox may be set to.'),
  OUTREACH_WORKSPACE_DAILY_CAP: cap(300, 'Messages a workspace may send per day across all its mailboxes.'),
  OUTREACH_DOMAIN_HOURLY_LIMIT: cap(3, 'Messages per hour to one recipient domain, per workspace.'),
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
});
