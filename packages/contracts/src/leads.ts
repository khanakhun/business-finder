import { z } from 'zod';
import { constantTimeEqual, fromBase64Url, hmacSha256, toBase64Url } from './encoding.ts';
import { defineEvent } from './events.ts';
import { BusinessId, SiteId } from './ids.ts';
import { CursorPageRequestSchema, cursorPage } from './pagination.ts';

// Leads from preview sites (BF-048): "this is my business, I'm interested" (claim), a contact request (in preview:
// to the agency, never to the business) and "don't contact me" (opt-out). Captured anonymously by the renderer with a
// signed form token, screened for spam, stored with consent and attribution, and handed to CRM automation.

export const LEAD_KINDS = ['claim_interest', 'contact_request', 'opt_out'] as const;
export const LeadKindSchema = z.enum(LEAD_KINDS);
export type LeadKind = z.infer<typeof LeadKindSchema>;

export const LEAD_SOURCES = ['banner', 'claim_page', 'contact_block', 'opt_out_link'] as const;
export const LeadSourceSchema = z.enum(LEAD_SOURCES);
export type LeadSource = z.infer<typeof LeadSourceSchema>;

export const LEAD_STATUSES = ['new', 'in_progress', 'qualified', 'discarded', 'spam'] as const;
export const LeadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatus = z.infer<typeof LeadStatusSchema>;

export const PREFERRED_CHANNELS = ['phone', 'whatsapp', 'email'] as const;

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? undefined : value))
    .optional();

/** `POST /v1/public/sites/leads` (anonymous, from the renderer's forms; JSON or form-encoded). */
export const PublicLeadRequestSchema = z
  .object({
    /** The page's site token (BF-036 view token). */
    siteToken: z.string().min(10).max(200),
    /** The form's signed render time (`signLeadFormToken`): minimum fill time, maximum age. */
    formToken: z.string().min(10).max(300),
    kind: LeadKindSchema,
    source: LeadSourceSchema,
    name: optionalText(120),
    email: z
      .string()
      .trim()
      .max(254)
      .transform((value) => (value === '' ? undefined : value))
      .pipe(z.email().optional())
      .optional(),
    phone: optionalText(40),
    whatsapp: optionalText(40),
    message: optionalText(2000),
    preferredChannel: z
      .enum(PREFERRED_CHANNELS)
      .or(z.literal('').transform(() => undefined))
      .optional(),
    preferredTime: optionalText(120),
    locale: z
      .string()
      .regex(/^[a-z]{2}$/)
      .default('en'),
    /** The consent checkbox and the version of the privacy text shown next to it. */
    consent: z
      .union([z.boolean(), z.literal('on'), z.literal('true')])
      .transform((value) => value === true || value === 'on' || value === 'true')
      .default(false),
    consentVersion: text(40).default(''),
    /** The ALTCHA proof-of-work payload (base64 JSON), when the browser ran the widget. */
    altcha: z.string().max(4000).optional(),
    /** Honeypot: a field people never see; anything in it marks a bot. */
    hp: z.string().max(500).optional(),
    /** Idempotency: the form's id for this submission (a retry sends the same). */
    submissionId: z.uuid(),
    /** The outreach campaign (`?c=`) and the outreach link's reference (`?r=`). */
    c: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
    r: z
      .string()
      .regex(/^[A-Za-z0-9._-]{8,512}$/)
      .optional(),
    /** Opt-out: also take the preview down (checked by default on the page). */
    removePreview: z
      .union([z.boolean(), z.literal('on'), z.literal('true')])
      .transform((value) => value === true || value === 'on' || value === 'true')
      .optional(),
    reason: optionalText(500),
    /** A plain form post (no JavaScript): the page path to come back to on the site (`?sent=…` is added). */
    next: z
      .string()
      .regex(/^\/[A-Za-z0-9/_.~-]{0,200}$/)
      .optional(),
  })
  .meta({ id: 'PublicLeadRequest' });
export type PublicLeadRequest = z.input<typeof PublicLeadRequestSchema>;
export type PublicLead = z.output<typeof PublicLeadRequestSchema>;

/** What the renderer shows after a submission (a message key; never whether the business exists elsewhere). */
export const PublicLeadResponseSchema = z
  .object({ status: z.literal('received'), messageKey: z.enum(['lead.received', 'optout.received']) })
  .meta({ id: 'PublicLeadResponse' });
export type PublicLeadResponse = z.infer<typeof PublicLeadResponseSchema>;

export const LeadAttributionSchema = z.object({
  campaignRef: z.string().max(64).nullable(),
  outreachRef: z.string().max(512).nullable(),
  siteVersionId: z.uuid().nullable(),
  generationJobId: z.uuid().nullable(),
  engine: z.string().max(40).nullable(),
});
export type LeadAttribution = z.infer<typeof LeadAttributionSchema>;

export const SpamVerdictSchema = z.object({
  score: z.number().min(0).max(100),
  signals: z.array(z.string().max(60)).max(20),
});
export type SpamVerdict = z.infer<typeof SpamVerdictSchema>;

export const SiteLeadSchema = z
  .object({
    id: z.uuid(),
    siteId: SiteId,
    businessId: BusinessId,
    businessName: z.string(),
    siteName: z.string(),
    kind: LeadKindSchema,
    source: LeadSourceSchema,
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    whatsapp: z.string().nullable(),
    message: z.string().nullable(),
    preferredChannel: z.enum(PREFERRED_CHANNELS).nullable(),
    preferredTime: z.string().nullable(),
    locale: z.string(),
    consent: z.object({ checked: z.boolean(), textVersion: z.string(), at: z.iso.datetime() }),
    attribution: LeadAttributionSchema,
    /** Admins only (`settings:manage`); null for others. */
    spam: SpamVerdictSchema.nullable(),
    status: LeadStatusSchema,
    handledBy: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'SiteLead' });
export type SiteLead = z.infer<typeof SiteLeadSchema>;

export const SiteLeadPageSchema = cursorPage(SiteLeadSchema).meta({ id: 'SiteLeadPage' });
export type SiteLeadPage = z.infer<typeof SiteLeadPageSchema>;

export const LeadListQuerySchema = CursorPageRequestSchema.extend({
  status: LeadStatusSchema.optional(),
  kind: LeadKindSchema.optional(),
  source: LeadSourceSchema.optional(),
  siteId: SiteId.optional(),
  businessId: BusinessId.optional(),
  campaign: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  /** Created on or after (ISO date or datetime). */
  from: z.iso.datetime().or(z.iso.date()).optional(),
}).meta({ id: 'LeadListQuery' });
export type LeadListQuery = z.infer<typeof LeadListQuerySchema>;

export const UpdateLeadRequestSchema = z
  .object({
    status: LeadStatusSchema.exclude(['spam']).optional(),
    /** A workspace member, or null to unassign. */
    handledBy: z.uuid().nullable().optional(),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to change')
  .meta({ id: 'UpdateLeadRequest' });
export type UpdateLeadRequest = z.infer<typeof UpdateLeadRequestSchema>;

export const LeadCountsSchema = z.object({ new: z.number().int().nonnegative() }).meta({ id: 'LeadCounts' });
export type LeadCounts = z.infer<typeof LeadCountsSchema>;

const leadPayload = {
  leadId: z.uuid(),
  siteId: SiteId,
  businessId: BusinessId,
};

/** A claim or a contact request arrived (not spam): CRM automation, outreach stops, analytics conversion. */
export const SiteLeadCaptured = defineEvent(
  'site.lead.captured',
  1,
  z.object({
    ...leadPayload,
    kind: z.enum(['claim_interest', 'contact_request']),
    source: LeadSourceSchema,
    /** The channel to call back on, and the person's first name (no other PII in events). */
    channel: z.enum(PREFERRED_CHANNELS).nullable(),
    contactName: z.string().max(60).nullable(),
    attribution: LeadAttributionSchema,
  }),
);

/** "Don't contact me" from a preview: do-not-contact now; suppression (BF-055); the preview down when asked. */
export const SiteOptOutRequested = defineEvent(
  'site.opt_out.requested',
  1,
  z.object({
    ...leadPayload,
    removePreview: z.boolean(),
    /** The outreach link's reference, when the opt-out came from one (BF-055 matches the address). */
    outreachRef: z.string().max(512).nullable(),
  }),
);

const FORM_TOKEN_PREFIX = 'f1';

/**
 * The token a lead form carries (BF-048, the renderer signs it when it renders the form):
 * `f1.<siteId>.<renderedAtMs>.<base64url(hmac_sha256(secret, "lead-form:" + siteId + ":" + renderedAtMs))>`. The API
 * checks the site and how long ago the form was rendered (too fast is a bot; too old is replayed).
 */
export async function signLeadFormToken(
  siteId: string,
  renderedAtMs: number,
  secret: string,
): Promise<string> {
  const mac = await hmacSha256(secret, `lead-form:${siteId}:${renderedAtMs}`);
  return `${FORM_TOKEN_PREFIX}.${siteId}.${renderedAtMs}.${toBase64Url(mac)}`;
}

export async function verifyLeadFormToken(
  token: string,
  secret: string,
): Promise<{ siteId: string; renderedAtMs: number } | undefined> {
  const [prefix, siteId, at, signature, ...rest] = token.split('.');
  if (prefix !== FORM_TOKEN_PREFIX || !siteId || !at || !signature || rest.length > 0) return undefined;
  if (!SiteId.safeParse(siteId).success || !/^\d{10,16}$/.test(at)) return undefined;
  const given = fromBase64Url(signature);
  if (!given) return undefined;
  return constantTimeEqual(given, await hmacSha256(secret, `lead-form:${siteId}:${at}`))
    ? { siteId, renderedAtMs: Number(at) }
    : undefined;
}
