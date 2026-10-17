import { FINDING_DEFINITIONS, type Finding, type PublishedContext } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businessContacts,
  businesses,
  categories,
  reviewInsights,
  sitePublications,
  sites,
  websiteAudits,
  websiteSnapshots,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type { DraftContact, DraftContextReader, DraftFinding } from '../../application/drafting/ports.ts';

// The read model a draft is grounded in (BF-051): the business, its contact, the latest audit's findings, the review
// insight's themes, the active preview publication and the site's language. Read-only across contexts.

const GENERIC =
  /^(info|contact|hello|bonjour|reservation|reservations|booking|admin|office|accueil|sales|team)@/i;
const SEVERITY: Record<string, DraftFinding['severity']> = {
  critical: 'high',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'low',
};

/** Where the address was published (the footer's source disclosure). */
const contextOf = (
  value: PublishedContext | null | undefined,
  source: string,
): DraftContact['publishedContext'] => {
  if (value?.pageKind === 'contact') return 'own_contact_page';
  if (value) return 'own_site_other';
  return source === 'manual' ? 'unknown' : 'directory';
};

@Injectable()
export class DrizzleDraftContext implements DraftContextReader {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async business(_organizationId: string, businessId: string) {
    const [row] = await getExecutor(this.db)
      .select({
        id: businesses.id,
        name: businesses.displayName,
        locality: businesses.locality,
        countryCode: businesses.countryCode,
        websiteUrl: businesses.websiteUrl,
        category: categories.labels,
      })
      .from(businesses)
      .leftJoin(categories, eq(categories.id, businesses.primaryCategoryId))
      .where(eq(businesses.id, businessId));
    return row ? { ...row, category: row.category ?? null } : undefined;
  }

  private toContact(row: {
    id: string;
    value: string;
    personName: string | null;
    subtype: string;
    source: string;
    publishedContext: unknown;
  }): DraftContact {
    return {
      id: row.id,
      email: row.value.toLowerCase(),
      personName: row.personName,
      generic: row.subtype === 'generic' || GENERIC.test(row.value),
      publishedContext: contextOf(row.publishedContext as PublishedContext | null, row.source),
    };
  }

  async contact(businessId: string, contactId: string) {
    const [row] = await getExecutor(this.db)
      .select({
        id: businessContacts.id,
        value: businessContacts.value,
        personName: businessContacts.personName,
        subtype: businessContacts.subtype,
        publishedContext: businessContacts.publishedContext,
        source: businessContacts.source,
        type: businessContacts.type,
      })
      .from(businessContacts)
      .where(and(eq(businessContacts.id, contactId), eq(businessContacts.businessId, businessId)));
    return row && row.type === 'email' ? this.toContact(row) : undefined;
  }

  async defaultContact(businessId: string) {
    const rows = await getExecutor(this.db)
      .select({
        id: businessContacts.id,
        value: businessContacts.value,
        personName: businessContacts.personName,
        subtype: businessContacts.subtype,
        publishedContext: businessContacts.publishedContext,
        source: businessContacts.source,
        confidence: businessContacts.confidence,
      })
      .from(businessContacts)
      .where(and(eq(businessContacts.businessId, businessId), eq(businessContacts.type, 'email')))
      .orderBy(desc(businessContacts.confidence))
      .limit(5);
    const best = rows.find((row) => !row.value.startsWith('erased:'));
    return best ? this.toContact(best) : undefined;
  }

  async findings(businessId: string) {
    const [audit] = await getExecutor(this.db)
      .select({ id: websiteAudits.id, findings: websiteAudits.findings })
      .from(websiteAudits)
      .where(and(eq(websiteAudits.businessId, businessId), eq(websiteAudits.isLatest, true)))
      .limit(1);
    if (!audit) return [];
    return (audit.findings as Finding[]).slice(0, 20).map((finding, index) => {
      const definition = FINDING_DEFINITIONS[finding.code] as {
        severity: string;
        title: { en: string; fr: string };
        explanation: { en: string; fr: string };
      };
      return {
        id: `finding_${index + 1}_${finding.code}`,
        code: finding.code,
        severity: SEVERITY[finding.severity] ?? SEVERITY[definition.severity] ?? 'low',
        text: { en: definition.explanation.en, fr: definition.explanation.fr },
        metric: finding.metric ? { name: finding.metric.name, value: finding.metric.value } : null,
      };
    });
  }

  async reviewThemes(organizationId: string, businessId: string) {
    const [insight] = await getExecutor(this.db)
      .select({ painCounts: reviewInsights.painCounts })
      .from(reviewInsights)
      .where(
        and(eq(reviewInsights.organizationId, organizationId), eq(reviewInsights.businessId, businessId)),
      )
      .orderBy(desc(reviewInsights.computedAt))
      .limit(1);
    if (!insight) return [];
    return Object.entries(insight.painCounts as Record<string, number>)
      .filter(([tag, count]) => tag !== 'other' && count > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tag, count]) => ({ id: `theme_${tag}`, tag, count }));
  }

  async preview(organizationId: string, businessId: string) {
    const [row] = await getExecutor(this.db)
      .select({
        siteId: sites.id,
        hostname: sitePublications.hostname,
        expiresAt: sitePublications.expiresAt,
      })
      .from(sitePublications)
      .innerJoin(sites, eq(sites.id, sitePublications.siteId))
      .where(
        and(
          eq(sites.organizationId, organizationId),
          eq(sites.businessId, businessId),
          eq(sitePublications.environment, 'preview'),
          eq(sitePublications.status, 'active'),
          isNull(sitePublications.endedAt),
        ),
      )
      .orderBy(desc(sitePublications.publishedAt))
      .limit(1);
    return row ? { siteId: row.siteId, url: `https://${row.hostname}/`, expiresAt: row.expiresAt } : null;
  }

  async siteLanguage(businessId: string) {
    const [row] = await getExecutor(this.db)
      .select({ languages: websiteSnapshots.languages })
      .from(websiteSnapshots)
      .where(eq(websiteSnapshots.businessId, businessId))
      .orderBy(desc(websiteSnapshots.fetchedAt))
      .limit(1);
    const section = row?.languages as { value?: { detected?: string[]; declared?: string[] } } | undefined;
    return section?.value?.detected?.[0] ?? section?.value?.declared?.[0] ?? null;
  }
}
