import { z } from 'zod';
import { BusinessId } from './ids.ts';
import { OfferSchema } from './taxonomy.ts';
import { IsoDateTimeSchema } from './time.ts';

// Email templates and drafts (BF-051): typed variables, logic-less templates (`{{var}}`, `{{#if}}…{{else}}…{{/if}}`,
// `{{#unless}}`, `{{#each}}…{{this}}…{{/each}}`), immutable template versions, drafts grounded in facts and findings.
// The compliance footer is never part of a template or draft body: it is composed deterministically at preview and
// send time (shared FooterComposer).

export const EMAIL_PURPOSES = ['first_touch', 'follow_up', 'breakup', 'reply'] as const;
export const EmailPurposeSchema = z.enum(EMAIL_PURPOSES);
export type EmailPurpose = z.infer<typeof EmailPurposeSchema>;

export const EMAIL_LOCALES = ['en', 'fr'] as const;
export const EmailLocaleSchema = z.enum(EMAIL_LOCALES);
export type EmailLocale = z.infer<typeof EmailLocaleSchema>;

/** Every variable a template may use, and its type. */
export const TEMPLATE_VARIABLES = {
  'business.name': { type: 'string', required: true },
  'business.locality': { type: 'string', required: false },
  'business.category': { type: 'string', required: false },
  'contact.firstName': { type: 'string', required: false },
  'contact.isGeneric': { type: 'boolean', required: true },
  'preview.url': { type: 'url', required: false },
  'preview.expiresAt': { type: 'string', required: false },
  'audit.topFindings': { type: 'list', required: false },
  'audit.mobileScore': { type: 'number', required: false },
  'reviews.topTheme': { type: 'string', required: false },
  'sender.firstName': { type: 'string', required: true },
  'sender.agencyName': { type: 'string', required: true },
  'offer.label': { type: 'string', required: true },
} as const satisfies Record<
  string,
  { type: 'string' | 'boolean' | 'url' | 'number' | 'list'; required: boolean }
>;
export type TemplateVariable = keyof typeof TEMPLATE_VARIABLES;
export const TEMPLATE_VARIABLE_NAMES = Object.keys(TEMPLATE_VARIABLES) as [
  TemplateVariable,
  ...TemplateVariable[],
];

/** Resolved values (missing optional ones are absent). */
export type TemplateValues = Partial<Record<TemplateVariable, string | number | boolean | readonly string[]>>;

export const LINT_SEVERITIES = ['error', 'warning'] as const;
export const LintIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(LINT_SEVERITIES),
  message: z.string(),
  /** Where: `subject[1]`, `body`, a variable name. */
  at: z.string().nullable(),
});
export type LintIssue = z.infer<typeof LintIssueSchema>;

export const EmailTemplateSchema = z
  .object({
    id: z.uuid(),
    /** Stable across versions (a template's identity). */
    key: z.string(),
    name: z.string(),
    purpose: EmailPurposeSchema,
    offer: OfferSchema,
    locale: EmailLocaleSchema,
    version: z.number().int().positive(),
    subjectVariants: z.array(z.string()),
    bodyMd: z.string(),
    variables: z.array(z.string()),
    status: z.enum(['active', 'archived']),
    seeded: z.boolean(),
    lint: z.array(LintIssueSchema),
    createdBy: z.uuid().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'EmailTemplate' });
export type EmailTemplate = z.infer<typeof EmailTemplateSchema>;

export const EmailTemplateListSchema = z
  .object({ items: z.array(EmailTemplateSchema) })
  .meta({ id: 'EmailTemplateList' });

const Subject = z.string().trim().min(3).max(150);

export const SaveEmailTemplateRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    purpose: EmailPurposeSchema,
    offer: OfferSchema,
    locale: EmailLocaleSchema,
    subjectVariants: z.array(Subject).min(1).max(5),
    bodyMd: z.string().trim().min(10).max(5000),
  })
  .meta({ id: 'SaveEmailTemplateRequest' });
export type SaveEmailTemplateRequest = z.input<typeof SaveEmailTemplateRequestSchema>;

export const LintTemplateResultSchema = z
  .object({ issues: z.array(LintIssueSchema), variables: z.array(z.string()) })
  .meta({ id: 'LintTemplateResult' });

// ── Drafts ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const DRAFT_STATUSES = ['draft', 'discarded', 'sent_as_message'] as const;
export const DraftSourceSchema = z.enum(['ai', 'template', 'human']);

export const DraftFactRefSchema = z.object({
  kind: z.enum(['fact', 'finding', 'review_theme', 'preview']),
  id: z.string(),
  label: z.string(),
});
export type DraftFactRef = z.infer<typeof DraftFactRefSchema>;

export const DraftClaimSchema = z.object({
  text: z.string(),
  supportedBy: z.array(z.string()),
  supported: z.boolean(),
});

export const EmailDraftSchema = z
  .object({
    id: z.uuid(),
    businessId: z.uuid(),
    contactId: z.uuid().nullable(),
    mailboxId: z.uuid().nullable(),
    templateId: z.uuid().nullable(),
    templateVersion: z.number().int().nullable(),
    purpose: EmailPurposeSchema,
    offer: OfferSchema,
    locale: EmailLocaleSchema,
    subject: z.string(),
    subjectVariants: z.array(z.string()),
    bodyMd: z.string(),
    factsUsed: z.array(DraftFactRefSchema),
    claims: z.array(DraftClaimSchema),
    lint: z.array(LintIssueSchema),
    generatedBy: DraftSourceSchema,
    aiMeta: z.record(z.string(), z.unknown()).nullable(),
    siteId: z.uuid().nullable(),
    status: z.enum(DRAFT_STATUSES),
    createdBy: z.uuid().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'EmailDraft' });
export type EmailDraft = z.infer<typeof EmailDraftSchema>;

export const CreateDraftRequestSchema = z
  .object({
    businessId: BusinessId,
    contactId: z.uuid().nullable().default(null),
    offer: OfferSchema,
    purpose: EmailPurposeSchema.default('first_touch'),
    mode: z.enum(['ai', 'template']).default('ai'),
    templateId: z.uuid().optional(),
    locale: EmailLocaleSchema.optional(),
    mailboxId: z.uuid().optional(),
    instructions: z.string().trim().max(300).optional(),
  })
  .meta({ id: 'CreateDraftRequest' });
export type CreateDraftRequest = z.input<typeof CreateDraftRequestSchema>;

export const UpdateDraftRequestSchema = z
  .object({
    subject: Subject.optional(),
    subjectVariants: z.array(Subject).max(5).optional(),
    bodyMd: z.string().trim().min(10).max(5000).optional(),
    mailboxId: z.uuid().nullable().optional(),
    locale: EmailLocaleSchema.optional(),
    status: z.enum(['draft', 'discarded']).optional(),
  })
  .meta({ id: 'UpdateDraftRequest' });
export type UpdateDraftRequest = z.input<typeof UpdateDraftRequestSchema>;

export const RegenerateDraftRequestSchema = z
  .object({ instructions: z.string().trim().max(300).optional() })
  .meta({ id: 'RegenerateDraftRequest' });

export const TranslateDraftRequestSchema = z
  .object({ locale: EmailLocaleSchema })
  .meta({ id: 'TranslateDraftRequest' });

export const RenderedEmailSchema = z
  .object({
    subject: z.string(),
    text: z.string(),
    html: z.string(),
    /** The footer lines (also inside text/html), for the composer's preview. */
    footer: z.array(z.string()),
    links: z.array(z.string()),
    /** The compliance decision for this recipient now (non-binding: the send re-evaluates). */
    compliance: z.record(z.string(), z.unknown()).nullable(),
    issues: z.array(LintIssueSchema),
  })
  .meta({ id: 'RenderedEmail' });
export type RenderedEmail = z.infer<typeof RenderedEmailSchema>;
