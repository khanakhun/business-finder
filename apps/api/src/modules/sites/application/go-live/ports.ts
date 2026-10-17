import type { SiteLegalProfile } from '@bf/contracts';

// Ports of going live (BF-062).

export interface ContactRoutingRecord {
  readonly siteId: string;
  readonly organizationId: string;
  readonly recipientEmail: string | null;
  readonly cc: string | null;
  readonly verifiedAt: Date | null;
  readonly pendingEmail: string | null;
  readonly pendingCc: string | null;
  readonly tokenHash: string | null;
  readonly tokenExpiresAt: Date | null;
}

/** What the readiness checks read beyond the site itself. */
export interface GoLiveContext {
  readonly businessId: string;
  readonly businessName: string;
  readonly pipelineStatus: string | null;
  readonly countryCode: string | null;
  /** The quality outcome of the generation job that produced the version (null: edited by hand). */
  readonly quality: 'succeeded' | 'needs_review' | 'failed' | null;
}

export interface GoLiveRepository {
  context(organizationId: string, siteId: string, versionId: string): Promise<GoLiveContext | undefined>;
  legal(organizationId: string, siteId: string): Promise<SiteLegalProfile | undefined>;
  saveLegal(
    organizationId: string,
    siteId: string,
    profile: Omit<SiteLegalProfile, 'version' | 'updatedAt'>,
    userId: string | null,
  ): Promise<SiteLegalProfile>;
  routing(organizationId: string, siteId: string): Promise<ContactRoutingRecord | undefined>;
  setPending(
    organizationId: string,
    siteId: string,
    pending: { email: string; cc: string | null; tokenHash: string; expiresAt: Date },
  ): Promise<void>;
  /** Confirms the pending address of the token's site; undefined when the token is unknown or expired. */
  confirm(tokenHash: string, now: Date): Promise<ContactRoutingRecord | undefined>;
}
export const GO_LIVE_REPOSITORY = Symbol('GoLiveRepository');
