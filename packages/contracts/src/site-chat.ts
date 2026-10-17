import { z } from 'zod';
import { RegistryFactKindSchema } from './facts.ts';
import { SiteId } from './ids.ts';

// Chat-based site editing (BF-047): threads of messages with an edit agent, and the change proposals it makes —
// SiteSpec operations validated on a dry run, applied by a person as a new version (author `chat_edit`), never
// published. Facts the user states become workspace facts only once confirmed.

const locale = z.string().regex(/^[a-z]{2}$/);

/** What the user is looking at when they write (the editor's selection). */
export const SiteChatContextSchema = z
  .object({
    pageId: z.string().max(80).optional(),
    blockId: z.string().max(80).optional(),
    locale: locale.optional(),
    viewport: z.enum(['desktop', 'tablet', 'mobile']).optional(),
    /** The version on screen. */
    baseVersionId: z.uuid().optional(),
  })
  .meta({ id: 'SiteChatContext' });
export type SiteChatContext = z.infer<typeof SiteChatContextSchema>;

/** One part of a message: text, a summarized tool call, a proposal, a clarifying question or a refusal. */
export const SiteChatPartSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().max(8000) }),
    z.object({ type: z.literal('tool'), tool: z.string().max(60), summary: z.string().max(300) }),
    z.object({ type: z.literal('proposal'), proposalId: z.uuid() }),
    z.object({
      type: z.literal('clarification'),
      question: z.string().max(500),
      options: z.array(z.string().max(120)).max(6),
    }),
    z.object({
      type: z.literal('refusal'),
      reason: z.string().max(500),
      alternatives: z.array(z.string().max(200)).max(4),
    }),
  ])
  .meta({ id: 'SiteChatPart' });
export type SiteChatPart = z.infer<typeof SiteChatPartSchema>;

export const SiteChatMessageSchema = z
  .object({
    id: z.uuid(),
    threadId: z.uuid(),
    role: z.enum(['user', 'assistant']),
    parts: z.array(SiteChatPartSchema),
    context: SiteChatContextSchema,
    costUsd: z.number().nonnegative(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SiteChatMessage' });
export type SiteChatMessage = z.infer<typeof SiteChatMessageSchema>;

export const SiteChatThreadSchema = z
  .object({
    id: z.uuid(),
    siteId: SiteId,
    title: z.string(),
    createdBy: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'SiteChatThread' });
export type SiteChatThread = z.infer<typeof SiteChatThreadSchema>;

export const SiteChatThreadListSchema = z
  .object({ items: z.array(SiteChatThreadSchema) })
  .meta({ id: 'SiteChatThreadList' });
export type SiteChatThreadList = z.infer<typeof SiteChatThreadListSchema>;

export const PROPOSAL_STATUSES = ['proposed', 'applied', 'discarded', 'superseded', 'failed'] as const;
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** A fact the user stated in the chat, waiting for their confirmation (BF-040 overlay once confirmed). */
export const PendingFactSchema = z.object({
  id: z.string().regex(/^pf_[a-z0-9]{1,20}$/),
  kind: RegistryFactKindSchema,
  value: z.unknown(),
  locale: locale.optional(),
  note: z.string().max(500).optional(),
});
export type PendingFact = z.infer<typeof PendingFactSchema>;

/** A validation finding on the proposed state (schema, facts, copy lint). */
export const ProposalIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string().max(80),
  message: z.string().max(600),
  path: z.array(z.union([z.string(), z.number()])).max(20),
});
export type ProposalIssue = z.infer<typeof ProposalIssueSchema>;

export const SiteChangeProposalSchema = z
  .object({
    id: z.uuid(),
    threadId: z.uuid(),
    messageId: z.uuid().nullable(),
    siteId: SiteId,
    baseVersionId: z.uuid(),
    /** BF-033 operations (applied together, atomically). */
    operations: z.array(z.record(z.string(), z.unknown())).max(40),
    /** In the user's UI language. */
    summary: z.string().max(1000),
    /** The structural diff from the base version (`@bf/site-schema/diff`). */
    diff: z.record(z.string(), z.unknown()),
    issues: z.array(ProposalIssueSchema),
    factsToAssert: z.array(PendingFactSchema).max(10),
    status: ProposalStatusSchema,
    /** Why it was superseded or failed. */
    statusReason: z.string().max(500).nullable(),
    appliedVersionId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'SiteChangeProposal' });
export type SiteChangeProposal = z.infer<typeof SiteChangeProposalSchema>;

export const SiteChatThreadDetailSchema = SiteChatThreadSchema.extend({
  messages: z.array(SiteChatMessageSchema),
  proposals: z.array(SiteChangeProposalSchema),
}).meta({ id: 'SiteChatThreadDetail' });
export type SiteChatThreadDetail = z.infer<typeof SiteChatThreadDetailSchema>;

export const ApplyProposalRequestSchema = z
  .object({
    /** The pending facts the user confirms (ids from `factsToAssert`); the others are not stored. */
    confirmFacts: z
      .array(z.string().regex(/^pf_[a-z0-9]{1,20}$/))
      .max(10)
      .default([]),
  })
  .meta({ id: 'ApplyProposalRequest' });
export type ApplyProposalRequest = z.input<typeof ApplyProposalRequestSchema>;

export const ApplyProposalResultSchema = z
  .object({
    proposal: SiteChangeProposalSchema,
    versionId: z.uuid(),
    versionNumber: z.number().int().positive(),
    /** True when the site had moved on and the operations were re-applied to its current version. */
    rebased: z.boolean(),
  })
  .meta({ id: 'ApplyProposalResult' });
export type ApplyProposalResult = z.infer<typeof ApplyProposalResultSchema>;

/** `POST /v1/sites/:id/chat`: one user message (a new thread when `threadId` is absent). */
export const SendSiteChatMessageRequestSchema = z
  .object({
    threadId: z.uuid().optional(),
    message: z.string().trim().min(1).max(4000),
    context: SiteChatContextSchema.default({}),
  })
  .meta({ id: 'SendSiteChatMessageRequest' });
export type SendSiteChatMessageRequest = z.input<typeof SendSiteChatMessageRequestSchema>;

export const TranslateSiteRequestSchema = z
  .object({ locale, scope: z.enum(['missing', 'all']).default('missing') })
  .meta({ id: 'TranslateSiteRequest' });
export type TranslateSiteRequest = z.input<typeof TranslateSiteRequestSchema>;
