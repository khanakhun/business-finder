import type { EmailLocale, EmailPurpose, EmailTemplate, LintIssue, Offer } from '@bf/contracts';

// Ports of drafting (BF-051).

export interface StoredTemplate {
  readonly id: string;
  readonly organizationId: string | null;
  readonly key: string;
  readonly name: string;
  readonly purpose: EmailPurpose;
  readonly offer: Offer;
  readonly locale: EmailLocale;
  readonly version: number;
  readonly subjectVariants: string[];
  readonly bodyMd: string;
  readonly variables: string[];
  readonly status: EmailTemplate['status'];
  readonly seeded: boolean;
  readonly lint: LintIssue[];
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface TemplateRepository {
  /** Every version visible to the workspace (its own and the seeds). */
  visible(organizationId: string): Promise<StoredTemplate[]>;
  find(organizationId: string, id: string): Promise<StoredTemplate | undefined>;
  versions(organizationId: string, key: string, locale: EmailLocale): Promise<StoredTemplate[]>;
  insert(row: Omit<StoredTemplate, 'id' | 'createdAt'>): Promise<StoredTemplate>;
  setStatus(organizationId: string, id: string, status: EmailTemplate['status']): Promise<void>;
}
export const TEMPLATE_REPOSITORY = Symbol('TemplateRepository');

// ── What a draft is grounded in ─────────────────────────────────────────────────────────────────────────────────

export interface DraftBusiness {
  readonly id: string;
  readonly name: string;
  readonly locality: string | null;
  readonly countryCode: string | null;
  readonly category: { readonly en: string; readonly fr: string } | null;
  readonly websiteUrl: string | null;
}

export interface DraftContact {
  readonly id: string;
  readonly email: string;
  readonly personName: string | null;
  readonly generic: boolean;
  readonly publishedContext: 'own_contact_page' | 'own_site_other' | 'directory' | 'unknown';
}

export interface DraftFinding {
  readonly id: string;
  readonly code: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly text: { readonly en: string; readonly fr: string };
  readonly metric: { readonly name: string; readonly value: number } | null;
}

export interface DraftPreview {
  readonly siteId: string;
  readonly url: string;
  readonly expiresAt: Date | null;
}

export interface DraftContextReader {
  business(organizationId: string, businessId: string): Promise<DraftBusiness | undefined>;
  contact(businessId: string, contactId: string): Promise<DraftContact | undefined>;
  /** The best email contact of the business when none is chosen. */
  defaultContact(businessId: string): Promise<DraftContact | undefined>;
  findings(businessId: string): Promise<DraftFinding[]>;
  reviewThemes(
    organizationId: string,
    businessId: string,
  ): Promise<{ id: string; tag: string; count: number }[]>;
  preview(organizationId: string, businessId: string): Promise<DraftPreview | null>;
  siteLanguage(businessId: string): Promise<string | null>;
}
export const DRAFT_CONTEXT = Symbol('DraftContextReader');

export interface StoredDraft {
  readonly id: string;
  readonly organizationId: string;
  readonly businessId: string;
  readonly contactId: string | null;
  readonly mailboxId: string | null;
  readonly templateId: string | null;
  readonly templateVersion: number | null;
  readonly purpose: EmailPurpose;
  readonly offer: Offer;
  readonly locale: EmailLocale;
  readonly subject: string;
  readonly subjectVariants: string[];
  readonly bodyMd: string;
  readonly factsUsed: { kind: 'fact' | 'finding' | 'review_theme' | 'preview'; id: string; label: string }[];
  readonly claims: { text: string; supportedBy: string[]; supported: boolean }[];
  readonly lint: LintIssue[];
  readonly generatedBy: 'ai' | 'template' | 'human';
  readonly aiMeta: Record<string, unknown> | null;
  readonly siteId: string | null;
  readonly compliancePreview: Record<string, unknown> | null;
  readonly status: 'draft' | 'discarded' | 'sent_as_message';
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DraftRepository {
  insert(row: Omit<StoredDraft, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoredDraft>;
  get(organizationId: string, id: string): Promise<StoredDraft | undefined>;
  update(
    organizationId: string,
    id: string,
    patch: Partial<Omit<StoredDraft, 'id' | 'organizationId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<StoredDraft>;
  forBusiness(organizationId: string, businessId: string, limit: number): Promise<StoredDraft[]>;
}
export const DRAFT_REPOSITORY = Symbol('DraftRepository');
