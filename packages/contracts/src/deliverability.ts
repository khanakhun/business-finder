import { z } from 'zod';
import { IsoDateTimeSchema } from './time.ts';

// Deliverability guardrails (BF-056): a sending domain's authentication (SPF, DKIM, DMARC, MX; MTA-STS, TLS-RPT and
// BIMI for information) with exact fix instructions, the readiness gate it feeds (a domain failing SPF or DKIM, or
// without DMARC, does not send unless an owner overrides it for that mailbox), rolling health with auto-pause, and a
// workspace kill switch.

export const CHECK_OUTCOMES = ['pass', 'warn', 'fail', 'unknown'] as const;
export const CheckOutcomeSchema = z.enum(CHECK_OUTCOMES);
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;

export const DNS_CHECKS = ['spf', 'dkim', 'dmarc', 'mx', 'mta_sts', 'tls_rpt', 'bimi'] as const;
export const DnsCheckIdSchema = z.enum(DNS_CHECKS);
export type DnsCheckId = z.infer<typeof DnsCheckIdSchema>;

const Localized = z.object({ en: z.string(), fr: z.string() });

export const DnsCheckSchema = z.object({
  id: DnsCheckIdSchema,
  outcome: CheckOutcomeSchema,
  /** What was found (the record, the selector, the lookup count…), for the person fixing it. */
  found: z.string().nullable(),
  summary: Localized,
  /** What to change, with the exact record when the provider is known. */
  fix: Localized.nullable(),
  informational: z.boolean(),
});
export type DnsCheck = z.infer<typeof DnsCheckSchema>;

export const DomainCheckSchema = z
  .object({
    domain: z.string(),
    provider: z.enum(['gmail', 'graph', 'smtp_imap', 'unknown']),
    /** Overall: `fail` when SPF or DKIM fails or DMARC is missing (the readiness gate). */
    outcome: CheckOutcomeSchema,
    checks: z.array(DnsCheckSchema),
    checkedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'DomainCheck' });
export type DomainCheck = z.infer<typeof DomainCheckSchema>;

export const MailboxReadinessSchema = z
  .object({
    mailboxId: z.uuid(),
    email: z.string(),
    domain: z.string(),
    ready: z.boolean(),
    /** Why it may not send automatically (codes: `spf_fail`, `dkim_fail`, `dmarc_missing`). */
    blockers: z.array(z.string()),
    override: z.object({ reason: z.string(), by: z.uuid().nullable(), at: IsoDateTimeSchema }).nullable(),
    check: DomainCheckSchema.nullable(),
  })
  .meta({ id: 'MailboxReadiness' });
export type MailboxReadiness = z.infer<typeof MailboxReadinessSchema>;

export const ReadinessListSchema = z
  .object({ items: z.array(MailboxReadinessSchema) })
  .meta({ id: 'MailboxReadinessList' });

export const ReadinessOverrideRequestSchema = z
  .object({ reason: z.string().trim().min(10).max(500) })
  .meta({ id: 'ReadinessOverrideRequest' });
