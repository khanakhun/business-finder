import { z } from 'zod';
import { IsoDateTimeSchema } from './time.ts';

// Going live (BF-062): the legal profile the generated legal pages are built from, the verified address contact
// forms are delivered to, the readiness checks (each pass/warn/fail with a fix), and the live publication.

const text = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => z.string().trim().max(max).nullable().default(null);

export const SiteLegalProfileSchema = z
  .object({
    businessLegalName: z.string(),
    legalForm: z.string().nullable(),
    /** SIRET/RCS or the jurisdiction's equivalent. */
    registration: z.string().nullable(),
    vatNumber: z.string().nullable(),
    address: z.string(),
    phone: z.string().nullable(),
    email: z.string(),
    publicationDirector: z.string().nullable(),
    dpoContact: z.string().nullable(),
    /** When the generated privacy notice was read and accepted. */
    privacyAcknowledgedAt: IsoDateTimeSchema.nullable(),
    /** The client reviewed the content (their name, and when). */
    contentConfirmedBy: z.string().nullable(),
    contentConfirmedAt: IsoDateTimeSchema.nullable(),
    version: z.number().int(),
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'SiteLegalProfile' });
export type SiteLegalProfile = z.infer<typeof SiteLegalProfileSchema>;

export const SaveSiteLegalProfileRequestSchema = z
  .object({
    businessLegalName: text(200),
    legalForm: optional(80),
    registration: optional(80),
    vatNumber: optional(40),
    address: text(400),
    phone: optional(40),
    email: z.email().max(320),
    publicationDirector: optional(120),
    dpoContact: optional(320),
    acknowledgePrivacy: z.boolean().default(false),
    /** The client's name: they reviewed the content. */
    contentConfirmedBy: optional(120),
  })
  .meta({ id: 'SaveSiteLegalProfileRequest' });
export type SaveSiteLegalProfileRequest = z.input<typeof SaveSiteLegalProfileRequestSchema>;

export const SiteContactRoutingSchema = z
  .object({
    recipientEmail: z.string().nullable(),
    cc: z.string().nullable(),
    verifiedAt: IsoDateTimeSchema.nullable(),
    /** An address waiting for its confirmation link. */
    pendingEmail: z.string().nullable(),
  })
  .meta({ id: 'SiteContactRouting' });
export type SiteContactRouting = z.infer<typeof SiteContactRoutingSchema>;

export const SetContactRoutingRequestSchema = z
  .object({ email: z.email().max(320), cc: z.email().max(320).nullable().default(null) })
  .meta({ id: 'SetContactRoutingRequest' });
export type SetContactRoutingRequest = z.input<typeof SetContactRoutingRequestSchema>;

export const ConfirmContactRoutingRequestSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/) })
  .meta({ id: 'ConfirmContactRoutingRequest' });

export const GO_LIVE_CHECKS = [
  'deal',
  'assets',
  'legal',
  'privacy',
  'routing',
  'content',
  'quality',
  'confirmation',
  'seo',
] as const;
export type GoLiveCheckId = (typeof GO_LIVE_CHECKS)[number];

export const GoLiveCheckSchema = z.object({
  id: z.enum(GO_LIVE_CHECKS),
  status: z.enum(['pass', 'warn', 'fail']),
  message: z.string(),
  /** The dashboard path that fixes it. */
  fix: z.string().nullable(),
});
export type GoLiveCheck = z.infer<typeof GoLiveCheckSchema>;

export const GoLiveReadinessSchema = z
  .object({
    siteId: z.uuid(),
    versionId: z.uuid(),
    checks: z.array(GoLiveCheckSchema),
    /** No failing check (warnings do not block; `deal` may be overridden with a reason). */
    ready: z.boolean(),
  })
  .meta({ id: 'GoLiveReadiness' });
export type GoLiveReadiness = z.infer<typeof GoLiveReadinessSchema>;

export const PublishLiveRequestSchema = z
  .object({
    versionId: z.uuid(),
    /** Going live without a deal (pipeline not at proposal or won): why. Needs `settings:manage` too. */
    overrideReason: z.string().trim().min(10).max(500).optional(),
  })
  .meta({ id: 'PublishLiveRequest' });
export type PublishLiveRequest = z.input<typeof PublishLiveRequestSchema>;

export const PublishLiveResultSchema = z
  .object({ publicationId: z.uuid(), hostname: z.string(), readiness: GoLiveReadinessSchema })
  .meta({ id: 'PublishLiveResult' });
export type PublishLiveResult = z.infer<typeof PublishLiveResultSchema>;

// ── Custom domains ──────────────────────────────────────────────────────────────────────────────────────────────

export const SITE_DOMAIN_KINDS = ['apex', 'subdomain', 'www'] as const;
export const SITE_DOMAIN_STATUSES = [
  'pending_dns',
  'verifying',
  'verified',
  'active',
  'failed',
  'removed',
] as const;
export type SiteDomainStatus = (typeof SITE_DOMAIN_STATUSES)[number];

const DnsRecordSchema = z.object({
  type: z.enum(['A', 'AAAA', 'CNAME', 'TXT']),
  name: z.string(),
  value: z.string(),
});

export const SiteDomainSchema = z
  .object({
    id: z.uuid(),
    hostname: z.string(),
    kind: z.enum(SITE_DOMAIN_KINDS),
    /** Redirects here (a `www` name to its apex). */
    redirectTo: z.string().nullable(),
    status: z.enum(SITE_DOMAIN_STATUSES),
    /** The records to create at the registrar. */
    records: z.array(DnsRecordSchema),
    report: z
      .object({
        checks: z.array(
          z.object({
            type: z.string(),
            name: z.string(),
            expected: z.string(),
            found: z.array(z.string()),
            ok: z.boolean(),
          }),
        ),
        checkedAt: IsoDateTimeSchema,
      })
      .nullable(),
    lastCheckedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'SiteDomain' });
export type SiteDomain = z.infer<typeof SiteDomainSchema>;

export const AddSiteDomainRequestSchema = z
  .object({
    hostname: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .regex(
        /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
        'A domain name, e.g. salon.com',
      ),
    /** For an apex domain: also serve `www.` (redirected to the apex). */
    includeWww: z.boolean().default(true),
  })
  .meta({ id: 'AddSiteDomainRequest' });
export type AddSiteDomainRequest = z.input<typeof AddSiteDomainRequestSchema>;
