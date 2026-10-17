import { z } from 'zod';
import { defineEvent } from './events.ts';
import { LocaleSchema } from './i18n.ts';
import { IsoDateTimeSchema } from './time.ts';
import { TimeZoneSchema } from './workspace.ts';

// Mailboxes (BF-050, ARCHITECTURE §12, DOMAIN §3.7): the partners' real mailboxes outreach sends from, with a daily
// cap that ramps up, sending windows in the recipient's timezone, rotation with sticky threads and a typed lifecycle.
// Credentials live only in the workspace vault; nothing here ever carries a token or password.

export const MAILBOX_PROVIDERS = ['gmail', 'graph', 'smtp_imap'] as const;
export const MailboxProviderKindSchema = z.enum(MAILBOX_PROVIDERS);
export type MailboxProviderKind = z.infer<typeof MailboxProviderKindSchema>;

/** Transport state per provider: Gmail `historyId`, Graph delta link, IMAP UIDVALIDITY/UID, push subscriptions. */
/** Internal (never returned by the API). */
export interface MailboxProviderState {
  readonly historyId?: string;
  readonly deltaLink?: string;
  readonly uidValidity?: string;
  readonly lastUid?: number;
  readonly push?: { readonly id: string; readonly expiresAt: string };
  /** SMTP/IMAP connection settings (no secret): host, port, TLS mode, username, append-to-Sent. */
  readonly smtp?: { readonly host: string; readonly port: number; readonly security: 'starttls' | 'tls' };
  readonly imap?: { readonly host: string; readonly port: number; readonly security: 'starttls' | 'tls' };
  readonly username?: string;
  readonly appendToSent?: boolean;
  readonly sentFolder?: string;
}

export const MAILBOX_STATUSES = ['connected', 'warming', 'active', 'paused', 'error'] as const;
export const MailboxStatusSchema = z.enum(MAILBOX_STATUSES);
export type MailboxStatus = z.infer<typeof MailboxStatusSchema>;

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export const WeekdaySchema = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof WeekdaySchema>;

/** Holiday calendars shipped as data (`apps/api/.../holidays.ts`). */
export const HOLIDAY_CALENDARS = ['FR', 'BL', 'MF', 'US'] as const;
export const HolidayCalendarSchema = z.enum(HOLIDAY_CALENDARS);
export type HolidayCalendar = z.infer<typeof HolidayCalendarSchema>;

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM (24 h)');

/** Gradual real sending only — no warm-up networks (ARCHITECTURE §12). */
export const MailboxRampSchema = z
  .object({
    enabled: z.boolean().default(true),
    startCap: z.number().int().min(1).max(500).default(10),
    increment: z.number().int().min(0).max(200).default(5),
    everyDays: z.number().int().min(1).max(30).default(2),
    maxCap: z.number().int().min(1).max(2000).default(50),
    /** Set when the ramp starts (connection), reset on request. */
    startedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .meta({ id: 'MailboxRamp' });
export type MailboxRamp = z.infer<typeof MailboxRampSchema>;

export const SendWindowSchema = z
  .object({
    days: z.array(WeekdaySchema).min(1).max(7).default(['mon', 'tue', 'wed', 'thu', 'fri']),
    start: TimeOfDay.default('08:30'),
    end: TimeOfDay.default('17:30'),
    /** Whose clock the window follows: the recipient's (default) or the mailbox's. */
    timezoneMode: z.enum(['recipient', 'mailbox']).default('recipient'),
    mailboxTimezone: TimeZoneSchema.default('America/St_Barthelemy'),
    holidayCalendars: z.array(HolidayCalendarSchema).max(HOLIDAY_CALENDARS.length).default([]),
  })
  .refine((window) => window.start < window.end, {
    message: 'The window must end after it starts',
    path: ['end'],
  })
  .meta({ id: 'SendWindow' });
export type SendWindow = z.infer<typeof SendWindowSchema>;

export const MailboxHealthSchema = z
  .object({
    checkedAt: IsoDateTimeSchema.nullable(),
    tokenOk: z.boolean().nullable(),
    reachable: z.boolean().nullable(),
    quotaOk: z.boolean().nullable(),
    sendTestOk: z.boolean().nullable(),
    /** Filled by BF-056 (SPF/DKIM/DMARC). */
    dns: z.record(z.string(), z.string()).nullable(),
  })
  .meta({ id: 'MailboxHealth' });
export type MailboxHealth = z.infer<typeof MailboxHealthSchema>;

export const MAILBOX_ERROR_CODES = [
  'auth_failed',
  'consent_revoked',
  'unreachable',
  'quota_exceeded',
  'rate_limited',
  'tls_required',
  'rejected',
  'unknown',
] as const;
export const MailboxErrorCodeSchema = z.enum(MAILBOX_ERROR_CODES);
export type MailboxErrorCode = z.infer<typeof MailboxErrorCodeSchema>;

export const MailboxLastErrorSchema = z.object({
  code: MailboxErrorCodeSchema,
  /** A short, credential-free description (never the provider's raw payload). */
  message: z.string().max(300),
  at: IsoDateTimeSchema,
});
export type MailboxLastError = z.infer<typeof MailboxLastErrorSchema>;

export const MailboxSchema = z
  .object({
    id: z.uuid(),
    ownerUserId: z.uuid().nullable(),
    provider: MailboxProviderKindSchema,
    email: z.email(),
    displayName: z.string(),
    status: MailboxStatusSchema,
    statusReason: z.string().nullable(),
    dailyCap: z.number().int(),
    ramp: MailboxRampSchema,
    window: SendWindowSchema,
    minIntervalSec: z.number().int(),
    locales: z.array(LocaleSchema),
    signatureMd: z.string(),
    replyTo: z.email().nullable(),
    health: MailboxHealthSchema,
    lastError: MailboxLastErrorSchema.nullable(),
    /** Today (in the mailbox timezone): the cap in force and what was used. */
    today: z.object({
      day: z.string(),
      effectiveCap: z.number().int(),
      sent: z.number().int(),
      failed: z.number().int(),
      bounced: z.number().int(),
      reserved: z.number().int(),
    }),
    /** When the window next opens for a recipient in the mailbox timezone (null when sending is stopped). */
    nextWindowAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Mailbox' });
export type Mailbox = z.infer<typeof MailboxSchema>;

export const MailboxListSchema = z.object({ items: z.array(MailboxSchema) }).meta({ id: 'MailboxList' });

export const MailboxUsageDaySchema = z.object({
  day: z.string(),
  planned: z.number().int(),
  sent: z.number().int(),
  failed: z.number().int(),
  bounced: z.number().int(),
  complaints: z.number().int(),
  replies: z.number().int(),
});
export type MailboxUsageDay = z.infer<typeof MailboxUsageDaySchema>;

export const MailboxEventSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  fromStatus: MailboxStatusSchema.nullable(),
  toStatus: MailboxStatusSchema.nullable(),
  detail: z.record(z.string(), z.unknown()),
  actorUserId: z.uuid().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type MailboxEvent = z.infer<typeof MailboxEventSchema>;

export const MailboxDetailSchema = z
  .object({
    mailbox: MailboxSchema,
    /** The last 30 days and the ramp plan for the next 14 (planned vs actual). */
    usage: z.array(MailboxUsageDaySchema),
    events: z.array(MailboxEventSchema),
  })
  .meta({ id: 'MailboxDetail' });
export type MailboxDetail = z.infer<typeof MailboxDetailSchema>;

export const TLS_MODES = ['starttls', 'tls'] as const;

const Host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$/, 'A host name');

/** SMTP + IMAP credentials; the password goes to the vault only and is never returned. */
export const ConnectSmtpMailboxRequestSchema = z
  .object({
    email: z.email().max(254),
    displayName: z.string().trim().min(1).max(120),
    smtp: z.object({
      host: Host,
      port: z.number().int().min(1).max(65_535),
      security: z.enum(TLS_MODES),
    }),
    /** Optional: without IMAP there is no reply sync and no copy in Sent (Mailpit in development has none). */
    imap: z
      .object({
        host: Host,
        port: z.number().int().min(1).max(65_535),
        /** IMAP is implicit TLS (993) or STARTTLS (143); never plain. */
        security: z.enum(TLS_MODES),
      })
      .optional(),
    username: z.string().min(1).max(254),
    password: z.string().min(1).max(512),
    /** Append each sent message to the Sent folder over IMAP (providers that do not do it themselves). */
    appendToSent: z.boolean().default(true),
    /** A shared mailbox (no personal owner) needs `settings:manage`. */
    shared: z.boolean().default(false),
  })
  .meta({ id: 'ConnectSmtpMailboxRequest' });
export type ConnectSmtpMailboxRequest = z.input<typeof ConnectSmtpMailboxRequestSchema>;

export const UpdateMailboxRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    dailyCap: z.number().int().min(1).max(2000).optional(),
    ramp: MailboxRampSchema.optional(),
    window: SendWindowSchema.optional(),
    minIntervalSec: z.number().int().min(30).max(3600).optional(),
    locales: z.array(LocaleSchema).min(1).max(4).optional(),
    signatureMd: z.string().max(4000).optional(),
    replyTo: z.email().max(254).nullable().optional(),
  })
  .meta({ id: 'UpdateMailboxRequest' });
export type UpdateMailboxRequest = z.input<typeof UpdateMailboxRequestSchema>;

export const PauseMailboxRequestSchema = z
  .object({ reason: z.string().trim().max(300).optional() })
  .meta({ id: 'PauseMailboxRequest' });

export const MailboxTestResultSchema = z
  .object({
    ok: z.boolean(),
    to: z.email(),
    rfc822MessageId: z.string().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'MailboxTestResult' });
export type MailboxTestResult = z.infer<typeof MailboxTestResultSchema>;

export const OAUTH_MAILBOX_PROVIDERS = ['google', 'microsoft'] as const;
export const OAuthMailboxProviderSchema = z.enum(OAUTH_MAILBOX_PROVIDERS);
export type OAuthMailboxProvider = z.infer<typeof OAuthMailboxProviderSchema>;

export const MailboxOAuthStartQuerySchema = z.object({
  /** A shared mailbox (no personal owner) needs `settings:manage`. */
  shared: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  /** Reconnect this mailbox instead of adding one. */
  mailboxId: z.uuid().optional(),
});

export const MailboxOAuthStartSchema = z.object({ url: z.url() }).meta({ id: 'MailboxOAuthStart' });

// ── Selection and capacity (BF-052 calls these) ─────────────────────────────────────────────────────────────────

export const MailboxSelectionSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), mailboxId: z.uuid(), sendAt: IsoDateTimeSchema, sticky: z.boolean() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['NO_CAPACITY', 'NO_MAILBOX', 'STICKY_UNAVAILABLE']),
    nextAvailableAt: IsoDateTimeSchema.nullable(),
  }),
]);
export type MailboxSelection = z.infer<typeof MailboxSelectionSchema>;

// ── Events ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every lifecycle transition (DOMAIN §3.7); BF-056 and the dashboard listen to it. */
export const MailboxStatusChanged = defineEvent(
  'mailbox.status.changed',
  1,
  z.object({
    mailboxId: z.uuid(),
    email: z.email(),
    from: MailboxStatusSchema.nullable(),
    to: MailboxStatusSchema,
    reason: z.string().max(300).nullable(),
    automatic: z.boolean(),
  }),
);

export const MailboxDisconnected = defineEvent(
  'mailbox.disconnected',
  1,
  z.object({ mailboxId: z.uuid(), email: z.email() }),
);
