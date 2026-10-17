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
