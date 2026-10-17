import type { PortalLead, SiteApprovalStatus } from '@bf/contracts';

// Ports of the client handover portal (BF-062).

export interface PortalGrantRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly email: string;
  readonly userId: string | null;
  readonly acceptedAt: Date | null;
  readonly createdAt: Date;
}

/** A site as its client sees it (only through an active grant). */
export interface PortalSiteRecord {
  readonly siteId: string;
  readonly organizationId: string;
  readonly businessId: string;
  readonly name: string;
  readonly status: string;
  readonly liveHostname: string | null;
  readonly previewHostname: string | null;
  readonly pendingApprovals: number;
}

export interface PortalViews {
  readonly pageViews: number;
  readonly uniqueEstimate: number;
  readonly byLocale: Record<string, number>;
  readonly daily: { day: string; pageViews: number }[];
}

export interface AttachmentRecord {
  readonly id: string;
  readonly siteId: string;
  readonly uploadedBy: string;
  readonly objectKey: string;
  readonly contentType: string;
  readonly changeRequestId: string | null;
}

export interface ChangeRequestRecord {
  readonly id: string;
  readonly siteId: string;
  readonly message: string;
  readonly pageHint: string | null;
  readonly taskId: string | null;
  readonly createdAt: Date;
  readonly attachments: { id: string; objectKey: string; contentType: string }[];
}

export interface ApprovalRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly note: string | null;
  readonly status: SiteApprovalStatus;
  readonly comment: string | null;
  readonly requestedAt: Date;
  readonly decidedAt: Date | null;
}

export interface PortalRepository {
  grants(organizationId: string, siteId: string): Promise<PortalGrantRecord[]>;
  /** The active grant for the address (created when missing). */
  grant(input: {
    id: string;
    organizationId: string;
    siteId: string;
    email: string;
    invitedBy: string | null;
  }): Promise<PortalGrantRecord>;
  revoke(organizationId: string, siteId: string, grantId: string, now: Date): Promise<boolean>;
  /** Whether the address belongs to an account with any workspace membership (staff never use the portal). */
  isStaff(email: string): Promise<boolean>;
  /** Links the address's grants to the account on its first visit. */
  claim(userId: string, email: string, now: Date): Promise<void>;
  sites(userId: string): Promise<PortalSiteRecord[]>;
  site(userId: string, siteId: string): Promise<PortalSiteRecord | undefined>;
  /** For the agency: the site of the workspace, in the same shape. */
  agencySite(organizationId: string, siteId: string): Promise<PortalSiteRecord | undefined>;
  views(siteId: string, sinceDay: string): Promise<PortalViews>;
  leadCount(siteId: string, since: Date): Promise<number>;
  leads(siteId: string, limit: number): Promise<PortalLead[]>;
  addAttachment(input: {
    id: string;
    organizationId: string;
    siteId: string;
    uploadedBy: string;
    objectKey: string;
    contentType: string;
    bytes: number;
  }): Promise<void>;
  attachments(siteId: string, ids: readonly string[]): Promise<AttachmentRecord[]>;
  addChangeRequest(
    input: {
      id: string;
      organizationId: string;
      siteId: string;
      requestedBy: string;
      message: string;
      pageHint: string | null;
    },
    attachmentIds: readonly string[],
  ): Promise<void>;
  setChangeRequestTask(id: string, taskId: string): Promise<void>;
  changeRequests(siteId: string, limit: number): Promise<ChangeRequestRecord[]>;
  versionNumber(siteId: string, versionId: string): Promise<number | undefined>;
  requestApproval(input: {
    id: string;
    organizationId: string;
    siteId: string;
    versionId: string;
    note: string | null;
    requestedBy: string | null;
  }): Promise<void>;
  approvals(siteId: string, limit: number): Promise<ApprovalRecord[]>;
  /** Decides a pending approval; undefined when it is not (or no longer) pending. */
  decide(
    siteId: string,
    approvalId: string,
    decision: { status: 'approved' | 'changes_requested'; comment: string | null; userId: string; now: Date },
  ): Promise<ApprovalRecord | undefined>;
}
export const PORTAL_REPOSITORY = Symbol('PortalRepository');
