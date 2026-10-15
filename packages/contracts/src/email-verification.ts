import { z } from 'zod';

// E-mail classification and verification (BF-028). Kept free of other contract imports: contacts, source records
// and workspace settings all embed these shapes.

/** Verifiers a workspace can chain (first that gives an answer wins; `dns` always answers). */
export const EMAIL_VERIFIERS = ['reacher', 'zerobounce', 'dns'] as const;
export const EmailVerifierIdSchema = z.enum(EMAIL_VERIFIERS);
export type EmailVerifierId = z.infer<typeof EmailVerifierIdSchema>;
export const DEFAULT_EMAIL_VERIFIERS: readonly EmailVerifierId[] = ['reacher', 'zerobounce', 'dns'];
/** What produced a verdict: a verifier, or the address alone (a disposable domain needs no mailbox check). */
export const EMAIL_CHECK_SOURCES = [...EMAIL_VERIFIERS, 'classification'] as const;

/** Where on its own site a business published an address (compliance: "published for that purpose"). */
export const PUBLISHED_PAGE_KINDS = ['contact', 'home', 'footer', 'legal', 'other'] as const;
/** How a crawl found it (BF-026 email sources). */
export const EMAIL_FOUND_AS = ['mailto', 'text', 'jsonld', 'cfemail', 'obfuscated'] as const;
export type PublishedPageKind = (typeof PUBLISHED_PAGE_KINDS)[number];
export type EmailFoundAs = (typeof EMAIL_FOUND_AS)[number];

export const PublishedContextSchema = z
  .object({
    pageUrl: z.string().max(2_000).nullable(),
    pageKind: z.enum(PUBLISHED_PAGE_KINDS),
    foundAs: z.enum(EMAIL_FOUND_AS).nullable(),
  })
  .meta({ id: 'PublishedContext' });
export type PublishedContext = z.infer<typeof PublishedContextSchema>;

export const EmailVerificationDetailsSchema = z
  .object({
    reachable: z.enum(['safe', 'risky', 'invalid', 'unknown']).describe('The verifier’s own verdict.'),
    isCatchAll: z.boolean().nullable(),
    isDisposable: z.boolean().nullable(),
    isRoleAccount: z.boolean().nullable(),
    mxAcceptsMail: z.boolean().nullable(),
    smtpCanConnect: z.boolean().nullable(),
    provider: z.string().max(100).nullable().describe('The mail provider, when the verifier knows it.'),
    checkedVia: z.enum(EMAIL_CHECK_SOURCES),
  })
  .meta({ id: 'EmailVerificationDetails' });
export type EmailVerificationDetails = z.infer<typeof EmailVerificationDetailsSchema>;

/** Why a port-25 probe failed (no provider text). */
export const SMTP_PROBE_ERRORS = ['timeout', 'refused', 'unreachable', 'dns', 'other'] as const;

/** `POST /v1/workspace/diagnostics/smtp-port`: can this deployment reach mail servers on port 25? */
export const SmtpPortDiagnosticSchema = z
  .object({
    reachable: z.boolean(),
    host: z.string().max(253).nullable().describe('The mail server tried (an MX of a large mail provider).'),
    latencyMs: z.number().int().min(0).nullable(),
    error: z.enum(SMTP_PROBE_ERRORS).nullable(),
    reacherConfigured: z
      .boolean()
      .describe('Whether this deployment has a Reacher backend (it needs port 25 to check mailboxes).'),
  })
  .meta({ id: 'SmtpPortDiagnostic' });
export type SmtpPortDiagnostic = z.infer<typeof SmtpPortDiagnosticSchema>;
