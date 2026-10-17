import type {
  LeadAttribution,
  LeadKind,
  LeadListQuery,
  LeadSource,
  LeadStatus,
  SpamVerdict,
} from '@bf/contracts';

// Ports of preview leads (BF-048).

/** The site a lead form belongs to, with its preview publication (active, or the latest one). */
export interface LeadSite {
  readonly siteId: string;
  readonly organizationId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly siteName: string;
  readonly hostname: string | null;
  /** Who created the site (a lead's task goes to them when the business has no owner). */
  readonly createdBy: string | null;
  readonly publicationId: string | null;
  /** The preview is published now. */
  readonly active: boolean;
  /** When the latest preview publication ended (null while active, or never published). */
  readonly endedAt: Date | null;
  readonly versionId: string | null;
  /** The generation job and engine behind the published version, when it was generated. */
  readonly generationJobId: string | null;
  readonly engine: string | null;
}

export interface StoredLead {
  readonly id: string;
  readonly organizationId: string;
  readonly siteId: string;
  readonly businessId: string;
  readonly publicationId: string | null;
  readonly kind: LeadKind;
  readonly source: LeadSource;
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly message: string | null;
  readonly preferredChannel: 'phone' | 'whatsapp' | 'email' | null;
  readonly preferredTime: string | null;
  readonly locale: string;
  readonly consent: { checked: boolean; textVersion: string; at: string };
  readonly attribution: LeadAttribution;
  readonly spam: SpamVerdict;
  readonly status: LeadStatus;
  readonly handledBy: string | null;
  readonly submissionId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListedLead extends StoredLead {
  readonly businessName: string;
  readonly siteName: string;
}

export interface LeadsRepository {
  siteForLead(siteId: string): Promise<LeadSite | undefined>;
  bySubmission(siteId: string, submissionId: string): Promise<StoredLead | undefined>;
  /** Inserts the lead; a concurrent retry of the same submission returns the existing one. */
  insert(
    lead: Omit<StoredLead, 'createdAt' | 'updatedAt' | 'handledBy'>,
  ): Promise<{ lead: StoredLead; created: boolean }>;
  list(
    organizationId: string,
    query: LeadListQuery & { after?: { createdAt: Date; id: string } },
  ): Promise<ListedLead[]>;
  get(organizationId: string, leadId: string): Promise<ListedLead | undefined>;
  update(
    organizationId: string,
    leadId: string,
    change: { status?: LeadStatus; handledBy?: string | null },
  ): Promise<boolean>;
  countNew(organizationId: string): Promise<number>;
  /** Retention: leads older than `before` (spam older than `spamBefore`), at most `limit`. */
  deleteBefore(before: Date, spamBefore: Date, limit: number): Promise<number>;
}
export const LEADS_REPOSITORY = Symbol('LeadsRepository');

/** Rate limits and replay checks, on a daily-salted hash of the network (never the IP itself). */
export interface LeadGuard {
  /** The request's network as an opaque daily hash (null without an IP). */
  networkHash(ip: string | undefined): Promise<string | null>;
  /** Counts this submission; true when over 5 an hour from this network for this site. */
  overIpLimit(siteId: string, networkHash: string): Promise<boolean>;
  /** Counts this submission; true when over 50 a day for this site. */
  overSiteLimit(siteId: string): Promise<boolean>;
  /** True when the same content was already submitted to this site in the last day. */
  repeated(siteId: string, contentHash: string): Promise<boolean>;
  /** True when this proof-of-work challenge was already used (each solves one submission). */
  challengeUsed(signature: string): Promise<boolean>;
  /** Spam seen for this site in the last hour (the proof-of-work difficulty follows it). */
  recentSpam(siteId: string): Promise<number>;
  noteSpam(siteId: string): Promise<void>;
}
export const LEAD_GUARD = Symbol('LeadGuard');

/** Self-hosted proof of work (ALTCHA): no third-party request from the renderer. */
export interface ProofOfWork {
  challenge(input: { siteId: string; hard: boolean }): Promise<Record<string, unknown>>;
  verify(payload: string): Promise<{ readonly ok: boolean; readonly signature: string | null }>;
}
export const PROOF_OF_WORK = Symbol('ProofOfWork');

/** The renderer's shared secret (BF-036): site tokens and lead form tokens. Null: lead capture is off. */
export const LEAD_TOKEN_SECRET = Symbol('LeadTokenSecret');
