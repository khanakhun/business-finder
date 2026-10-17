import { z } from 'zod';
import { DecisionReasonSchema } from './compliance.ts';
import { BusinessId } from './ids.ts';
import { ManualContactLogSchema } from './outbound.ts';
import { OfferSchema } from './taxonomy.ts';
import { IsoDateTimeSchema } from './time.ts';

// Call and WhatsApp assist (BF-057): people dial and send; the system prepares a grounded call script and a short
// WhatsApp message, suggests when to call from the opening hours, shows the channel's compliance decision before any
// action, and logs outcomes that move the CRM (manual contact logs, BF-052).

export const CALL_OUTCOMES = [
  'no_answer',
  'voicemail',
  'interested',
  'not_interested',
  'call_back',
  'info_email',
  'info_whatsapp',
  'wrong_number',
  'do_not_call',
] as const;
export const CallOutcomeSchema = z.enum(CALL_OUTCOMES);
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

export const CallScriptSchema = z
  .object({
    opener: z.string(),
    observations: z.array(z.object({ text: z.string(), sourceIds: z.array(z.string()) })),
    previewMention: z.string().nullable(),
    questions: z.array(z.string()),
    objections: z.array(z.object({ objection: z.string(), answer: z.string() })),
    nextStep: z.string(),
    reminders: z.array(z.string()),
    locale: z.enum(['en', 'fr']),
    generatedAt: IsoDateTimeSchema,
    cached: z.boolean(),
  })
  .meta({ id: 'CallScript' });
export type CallScript = z.infer<typeof CallScriptSchema>;

export const BestTimeSchema = z
  .object({
    goodNow: z.boolean(),
    /** The next good moment (now when good now); null without any hours to go by. */
    nextAt: IsoDateTimeSchema.nullable(),
    timeZone: z.string(),
    /** Why: `open_hours`, `default_hours`, `rush` (a busy service), `closed`. */
    reason: z.string(),
  })
  .meta({ id: 'BestTime' });
export type BestTime = z.infer<typeof BestTimeSchema>;

const ChannelDecision = z.object({ decision: z.string(), reasons: z.array(DecisionReasonSchema) });

export const CallWorkspaceSchema = z
  .object({
    businessId: BusinessId,
    businessName: z.string(),
    phone: z.object({ contactId: z.uuid(), e164: z.string(), label: z.string() }).nullable(),
    whatsapp: z.object({ contactId: z.uuid().nullable(), e164: z.string() }).nullable(),
    previewUrl: z.string().nullable(),
    compliance: z.object({ phone: ChannelDecision, whatsapp: ChannelDecision }),
    doNotContact: z.boolean(),
    bestTime: BestTimeSchema,
    history: z.array(ManualContactLogSchema),
  })
  .meta({ id: 'CallWorkspace' });
export type CallWorkspace = z.infer<typeof CallWorkspaceSchema>;

export const CallScriptRequestSchema = z
  .object({
    offer: OfferSchema.default('website_redesign'),
    locale: z.enum(['en', 'fr']).optional(),
    regenerate: z.boolean().default(false),
  })
  .meta({ id: 'CallScriptRequest' });
export type CallScriptRequest = z.input<typeof CallScriptRequestSchema>;

export const WhatsAppDraftSchema = z
  .object({ text: z.string(), waUrl: z.string(), e164: z.string() })
  .meta({ id: 'WhatsAppDraft' });
export type WhatsAppDraft = z.infer<typeof WhatsAppDraftSchema>;

export const WhatsAppDraftRequestSchema = z
  .object({
    locale: z.enum(['en', 'fr']).optional(),
    /** The edited message (link and opt-out included): only the wa.me URL is rebuilt. */
    text: z.string().trim().max(600).optional(),
    /** The user confirmed the phone number is on WhatsApp (no WhatsApp number known). */
    usePhone: z.boolean().default(false),
  })
  .meta({ id: 'WhatsAppDraftRequest' });
export type WhatsAppDraftRequest = z.input<typeof WhatsAppDraftRequestSchema>;

export const LogOutcomeRequestSchema = z
  .object({
    channel: z.enum(['phone', 'whatsapp']),
    outcome: CallOutcomeSchema.optional(),
    notes: z.string().trim().max(2_000).default(''),
    durationSec: z
      .number()
      .int()
      .min(0)
      .max(4 * 3_600)
      .optional(),
    callbackAt: IsoDateTimeSchema.optional(),
    contactId: z.uuid().nullable().default(null),
    /** "Do not call": also mark the business do-not-contact. */
    doNotContact: z.boolean().default(false),
    /** The offline queue's key: the same outcome is logged once. */
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,120}$/),
  })
  .meta({ id: 'LogOutcomeRequest' });
export type LogOutcomeRequest = z.input<typeof LogOutcomeRequestSchema>;

export const LogOutcomeResultSchema = z
  .object({
    log: ManualContactLogSchema,
    /** What the app opens next: the composer ("as discussed"), WhatsApp assist, or nothing. */
    next: z.enum(['compose', 'whatsapp']).nullable(),
    duplicate: z.boolean(),
  })
  .meta({ id: 'LogOutcomeResult' });
export type LogOutcomeResult = z.infer<typeof LogOutcomeResultSchema>;

export const CallListItemSchema = z.object({
  businessId: BusinessId,
  businessName: z.string(),
  tier: z.string().nullable(),
  phone: z.string(),
  taskId: z.uuid().nullable(),
  taskTitle: z.string().nullable(),
  dueAt: IsoDateTimeSchema.nullable(),
  previewUrl: z.string().nullable(),
  bestTime: BestTimeSchema,
});

export const CallListSchema = z
  .object({ tasks: z.array(CallListItemSchema), suggestions: z.array(CallListItemSchema) })
  .meta({ id: 'CallList' });
export type CallList = z.infer<typeof CallListSchema>;
