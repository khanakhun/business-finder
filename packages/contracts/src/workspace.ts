import { z } from 'zod';
import { LocaleSchema } from './i18n.ts';
import { CursorPageRequestSchema, cursorPage } from './pagination.ts';
import { IsoDateTimeSchema } from './time.ts';

// Workspace API shapes (BF-011): settings (identity, postal address, locales, timezone, feature flags), the secrets
// registry and vault metadata, the audit log.

/** Agency postal address: mandatory in every outreach footer (outreach-compliance.md §2). */
export const PostalAddressSchema = z
  .object({
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(1).max(20),
    region: z.string().trim().max(100).optional(),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .describe('ISO 3166-1 alpha-2, e.g. BL (Saint-Barthélemy), MF (Saint-Martin), FR.'),
  })
  .meta({ id: 'PostalAddress' });
export type PostalAddress = z.infer<typeof PostalAddressSchema>;

/** Defaults for outbound messages; the person-level sender comes from the mailbox (BF-050). */
export const SenderDefaultsSchema = z
  .object({
    fromName: z.string().trim().max(100).optional(),
    signatureMarkdown: z.string().max(2000).optional(),
  })
  .meta({ id: 'SenderDefaults' });
export type SenderDefaults = z.infer<typeof SenderDefaultsSchema>;

/**
 * Per-workspace product flags. A flag with an `env` switch is usable only when that infrastructure flag is on
 * too (a workspace cannot enable what the deployment disabled); otherwise it is always available.
 */
export const FEATURE_FLAGS = {
  autoSend: { default: false, env: 'FEATURE_AUTO_SEND' },
  codingEngines: { default: true, env: 'FEATURE_CODING_ENGINES' },
  mapsScraper: { default: false, env: 'FEATURE_MAPS_SCRAPER' },
  semanticSearch: { default: true },
} as const satisfies Record<string, { readonly default: boolean; readonly env?: string }>;
export type FeatureFlag = keyof typeof FEATURE_FLAGS;
export const FEATURE_FLAG_NAMES = Object.keys(FEATURE_FLAGS) as [FeatureFlag, ...FeatureFlag[]];
export const FeatureFlagSchema = z.enum(FEATURE_FLAG_NAMES);

/** Stored workspace choices (`org_settings.features`); unset flags take the registry default. */
export const FeatureFlagsSchema = z
  .partialRecord(FeatureFlagSchema, z.boolean())
  .meta({ id: 'FeatureFlags' });
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

export const FeatureFlagStateSchema = z
  .object({
    enabled: z
      .boolean()
      .describe('Effective value: the workspace choice (or default) and the deployment switch.'),
    workspaceValue: z.boolean().describe("The workspace's own choice, or the default when it never chose."),
    available: z.boolean().describe('False when the deployment disabled this feature.'),
  })
  .meta({ id: 'FeatureFlagState' });

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const TimeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, 'Unknown IANA time zone')
  .describe('IANA time zone, e.g. America/St_Barthelemy.');

const WebsiteUrlSchema = z.url({ protocol: /^https?$/ }).max(500);

/** What outreach still needs from the workspace before anything can be sent (compliance §2). */
export const OUTREACH_REQUIREMENTS = ['agency_name', 'postal_address'] as const;
export const OutreachReadinessSchema = z
  .object({
    ready: z.boolean(),
    missing: z.array(z.enum(OUTREACH_REQUIREMENTS)),
  })
  .meta({ id: 'OutreachReadiness' });
export type OutreachReadiness = z.infer<typeof OutreachReadinessSchema>;

/** `GET /v1/workspace/settings`. */
export const OrgSettingsSchema = z
  .object({
    agencyName: z.string().nullable(),
    legalName: z.string().nullable(),
    postalAddress: PostalAddressSchema.nullable(),
    websiteUrl: z.string().nullable(),
    hasLogo: z.boolean().describe('Fetch it from GET /v1/workspace/logo.'),
    primaryLocale: LocaleSchema,
    locales: z.array(LocaleSchema).min(1),
    timezone: z.string(),
    senderDefaults: SenderDefaultsSchema,
    features: z.record(FeatureFlagSchema, FeatureFlagStateSchema),
    outreachReadiness: OutreachReadinessSchema,
    updatedAt: IsoDateTimeSchema.nullable().describe('Null until the settings are first saved.'),
  })
  .meta({ id: 'OrgSettings' });
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

/** `PATCH /v1/workspace/settings`: only the fields sent change; `null` clears an optional field. */
export const UpdateOrgSettingsRequestSchema = z
  .object({
    agencyName: z.string().trim().min(1).max(200).nullable(),
    legalName: z.string().trim().min(1).max(200).nullable(),
    postalAddress: PostalAddressSchema.nullable(),
    websiteUrl: WebsiteUrlSchema.nullable(),
    primaryLocale: LocaleSchema,
    locales: z.array(LocaleSchema).min(1).max(10),
    timezone: TimeZoneSchema,
    senderDefaults: SenderDefaultsSchema,
    features: FeatureFlagsSchema,
  })
  .partial()
  .refine((body) => !body.locales || new Set(body.locales).size === body.locales.length, {
    message: 'Locales must be unique',
    path: ['locales'],
  })
  .meta({ id: 'UpdateOrgSettingsRequest' });
export type UpdateOrgSettingsRequest = z.infer<typeof UpdateOrgSettingsRequestSchema>;

/** Logo formats accepted by `PUT /v1/workspace/logo` (raw body). No SVG: it can carry scripts. */
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const LOGO_MAX_BYTES = 512 * 1024;

// --- Secrets ---------------------------------------------------------------------------------------------------

export interface SecretDefinition {
  readonly provider: string;
  /** English description for API consumers; the dashboard has its own localized labels. */
  readonly description: string;
  /** Use the deployment-wide env value (`globalEnv`) when the workspace has not set its own. */
  readonly allowGlobalFallback: boolean;
  readonly globalEnv?: string;
  /** Loose format check (a regex source) to catch pasting the wrong value; not a validity test. */
  readonly validatePattern?: string;
}

/** Every secret a workspace can store. Provider tickets add entries (and register a connection tester). */
export const SECRET_DEFINITIONS = {
  google_places: {
    provider: 'google',
    description: 'Google Places API key (discovery).',
    allowGlobalFallback: true,
    globalEnv: 'GOOGLE_PLACES_API_KEY',
    validatePattern: '^AIza[0-9A-Za-z_-]{35}$',
  },
  pagespeed: {
    provider: 'google',
    description: 'PageSpeed Insights API key (website audits).',
    allowGlobalFallback: true,
    globalEnv: 'PAGESPEED_API_KEY',
    validatePattern: '^AIza[0-9A-Za-z_-]{35}$',
  },
  anthropic: {
    provider: 'anthropic',
    description: 'Anthropic API key (LLM tasks, coding agents).',
    allowGlobalFallback: true,
    globalEnv: 'ANTHROPIC_API_KEY',
    validatePattern: '^sk-ant-[0-9A-Za-z_-]{20,}$',
  },
  openai: {
    provider: 'openai',
    description: 'OpenAI API key (LLM tasks, Codex engine).',
    allowGlobalFallback: true,
    globalEnv: 'OPENAI_API_KEY',
    validatePattern: '^sk-[0-9A-Za-z_-]{20,}$',
  },
  foursquare: {
    provider: 'foursquare',
    description: 'Foursquare Places API key (discovery).',
    allowGlobalFallback: true,
    globalEnv: 'FOURSQUARE_API_KEY',
  },
  huggingface: {
    provider: 'huggingface',
    description: 'Hugging Face access token (datasets, models).',
    allowGlobalFallback: true,
    globalEnv: 'HF_TOKEN',
    validatePattern: '^hf_[0-9A-Za-z]{20,}$',
  },
  unsplash: {
    provider: 'unsplash',
    description: 'Unsplash access key (stock photos for preview sites).',
    allowGlobalFallback: true,
    globalEnv: 'UNSPLASH_ACCESS_KEY',
  },
} as const satisfies Record<string, SecretDefinition>;
export type SecretName = keyof typeof SECRET_DEFINITIONS;
export const SECRET_NAMES = Object.keys(SECRET_DEFINITIONS) as [SecretName, ...SecretName[]];
export const SecretNameSchema = z.enum(SECRET_NAMES);

export const secretDefinition = (name: SecretName): SecretDefinition => SECRET_DEFINITIONS[name];

/** One registry entry and its state. The value itself is never returned (security.md §2). */
export const SecretSummarySchema = z
  .object({
    name: SecretNameSchema,
    provider: z.string(),
    description: z.string(),
    source: z
      .enum(['workspace', 'global'])
      .nullable()
      .describe(
        'Where the value would come from: the workspace vault, the deployment env, or nowhere (null).',
      ),
    last4: z.string().nullable().describe('Last four characters of the workspace value (long values only).'),
    updatedAt: IsoDateTimeSchema.nullable(),
    lastUsedAt: IsoDateTimeSchema.nullable(),
    allowGlobalFallback: z.boolean(),
    testable: z.boolean().describe('Whether POST /v1/workspace/secrets/{name}/test is available.'),
  })
  .meta({ id: 'SecretSummary' });
export type SecretSummary = z.infer<typeof SecretSummarySchema>;

export const SecretListSchema = z.object({ items: z.array(SecretSummarySchema) }).meta({ id: 'SecretList' });
export type SecretList = z.infer<typeof SecretListSchema>;

export const PutSecretRequestSchema = z
  .object({ value: z.string().trim().min(1).max(8192) })
  .meta({ id: 'PutSecretRequest' });
export type PutSecretRequest = z.infer<typeof PutSecretRequestSchema>;

export const SecretTestResultSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().optional().describe('Short provider answer; never contains the secret.'),
    source: z.enum(['workspace', 'global']),
    testedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'SecretTestResult' });
export type SecretTestResult = z.infer<typeof SecretTestResultSchema>;

// --- Audit log -------------------------------------------------------------------------------------------------

export const AUDIT_ACTOR_TYPES = ['user', 'api_key', 'system'] as const;
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

/** Dotted lower-case action, e.g. `secrets.updated`, `identity.member_invited`. */
export const AuditActionSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

export const AuditLogEntrySchema = z
  .object({
    id: z.uuid(),
    actorType: AuditActorTypeSchema,
    actorId: z.string().nullable(),
    action: AuditActionSchema,
    entityType: z.string().nullable(),
    entityId: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    occurredAt: IsoDateTimeSchema,
  })
  .meta({ id: 'AuditLogEntry' });
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

/** `GET /v1/audit-logs` filters (all optional, combined with AND), newest first. */
export const AuditLogQuerySchema = CursorPageRequestSchema.extend({
  action: z
    .string()
    .regex(/^[a-z][a-z0-9_.]*$/)
    .max(100)
    .optional()
    .describe('Action prefix, e.g. `secrets.` or `identity.member_invited`.'),
  actorId: z.string().min(1).max(100).optional(),
  entityType: z.string().min(1).max(100).optional(),
  entityId: z.string().min(1).max(100).optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
}).meta({ id: 'AuditLogQuery' });
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;

export const AuditLogPageSchema = cursorPage(AuditLogEntrySchema).meta({ id: 'AuditLogPage' });
export type AuditLogPage = z.infer<typeof AuditLogPageSchema>;
