import { z } from 'zod';
import { LeadKindSchema, LeadStatusSchema } from './leads.ts';
import { IsoDateTimeSchema } from './time.ts';

// The client handover portal (BF-062): the business owner signs in with a magic link and sees only the sites they
// were granted — the live address and status, views and leads, change requests (with screenshots) that become tasks
// for the agency, and approvals of the versions the agency proposes.

// ── Agency side ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PortalGrantSchema = z
  .object({
    id: z.uuid(),
    siteId: z.uuid(),
    email: z.string(),
    /** Set on the client's first sign-in. */
    acceptedAt: IsoDateTimeSchema.nullable(),
    invitedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'PortalGrant' });
export type PortalGrant = z.infer<typeof PortalGrantSchema>;

export const InvitePortalClientRequestSchema = z
  .object({ email: z.email().max(320), locale: z.enum(['en', 'fr']).default('fr') })
  .meta({ id: 'InvitePortalClientRequest' });
export type InvitePortalClientRequest = z.input<typeof InvitePortalClientRequestSchema>;

export const SITE_APPROVAL_STATUSES = ['pending', 'approved', 'changes_requested', 'withdrawn'] as const;
export type SiteApprovalStatus = (typeof SITE_APPROVAL_STATUSES)[number];

export const SiteApprovalSchema = z
  .object({
    id: z.uuid(),
    siteId: z.uuid(),
    versionId: z.uuid(),
    versionNumber: z.number().int(),
    /** Where the client looks at the proposed version (the active preview), when it is published. */
    previewUrl: z.string().nullable(),
    note: z.string().nullable(),
    status: z.enum(SITE_APPROVAL_STATUSES),
    comment: z.string().nullable(),
    requestedAt: IsoDateTimeSchema,
    decidedAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'SiteApproval' });
export type SiteApproval = z.infer<typeof SiteApprovalSchema>;

export const RequestApprovalSchema = z
  .object({ versionId: z.uuid(), note: z.string().trim().max(1_000).nullable().default(null) })
  .meta({ id: 'RequestApproval' });
export type RequestApproval = z.input<typeof RequestApprovalSchema>;

export const ChangeRequestSchema = z
  .object({
    id: z.uuid(),
    siteId: z.uuid(),
    message: z.string(),
    pageHint: z.string().nullable(),
    /** Presigned download links (agency side, valid one hour); empty for the client. */
    attachments: z.array(z.object({ id: z.uuid(), url: z.string().nullable(), contentType: z.string() })),
    taskId: z.uuid().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'ChangeRequest' });
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;

// ── Client side ─────────────────────────────────────────────────────────────────────────────────────────────────

export const PortalSiteSchema = z
  .object({
    siteId: z.uuid(),
    name: z.string(),
    status: z.string(),
    liveUrl: z.string().nullable(),
    previewUrl: z.string().nullable(),
    pendingApprovals: z.number().int(),
  })
  .meta({ id: 'PortalSite' });
export type PortalSite = z.infer<typeof PortalSiteSchema>;

export const PortalStatsSchema = z
  .object({
    days: z.number().int(),
    pageViews: z.number().int(),
    uniqueEstimate: z.number().int(),
    byLocale: z.record(z.string(), z.number().int()),
    daily: z.array(z.object({ day: z.string(), pageViews: z.number().int() })),
    leads: z.number().int(),
  })
  .meta({ id: 'PortalStats' });
export type PortalStats = z.infer<typeof PortalStatsSchema>;

export const PortalLeadSchema = z
  .object({
    id: z.uuid(),
    kind: LeadKindSchema,
    status: LeadStatusSchema,
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    message: z.string().nullable(),
    locale: z.string(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'PortalLead' });
export type PortalLead = z.infer<typeof PortalLeadSchema>;

export const PORTAL_ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const PORTAL_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export const PortalAttachmentUploadRequestSchema = z
  .object({
    contentType: z.enum(PORTAL_ATTACHMENT_TYPES),
    bytes: z.number().int().min(1).max(PORTAL_ATTACHMENT_MAX_BYTES),
  })
  .meta({ id: 'PortalAttachmentUploadRequest' });
export type PortalAttachmentUploadRequest = z.input<typeof PortalAttachmentUploadRequestSchema>;

export const PortalAttachmentUploadSchema = z
  .object({ id: z.uuid(), uploadUrl: z.string(), headers: z.record(z.string(), z.string()) })
  .meta({ id: 'PortalAttachmentUpload' });
export type PortalAttachmentUpload = z.infer<typeof PortalAttachmentUploadSchema>;

export const CreateChangeRequestSchema = z
  .object({
    message: z.string().trim().min(5).max(4_000),
    pageHint: z.string().trim().max(200).nullable().default(null),
    attachmentIds: z.array(z.uuid()).max(3).default([]),
  })
  .meta({ id: 'CreateChangeRequest' });
export type CreateChangeRequest = z.input<typeof CreateChangeRequestSchema>;

export const DecideApprovalSchema = z
  .object({
    decision: z.enum(['approved', 'changes_requested']),
    comment: z.string().trim().max(4_000).nullable().default(null),
  })
  .meta({ id: 'DecideApproval' });
export type DecideApproval = z.input<typeof DecideApprovalSchema>;
