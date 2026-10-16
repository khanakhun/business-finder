import { FINDING_DEFINITIONS, type FindingCode } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businesses,
  categories,
  orgSettings,
  reviewInsights,
  websiteAudits,
  websiteSnapshots,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { BriefSources, BriefSourcesReader } from '../application/facts.ports.ts';

// What the brief reads besides the registry (BF-040): the business and its category, the latest crawl (languages,
// image candidates), the latest audit's findings, the workspace's review themes and locales.
// DECISION(BF-040): image counts come from the crawl's candidates here (a preview); the workspace builder counts the
// site's ranked assets instead.

const LARGE = 1200;

@Injectable()
export class DrizzleBriefSources implements BriefSourcesReader {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async read(organizationId: string, businessId: string): Promise<BriefSources | undefined> {
    const x = getExecutor(this.db);
    const [business] = await x
      .select({
        name: businesses.displayName,
        websiteUrl: businesses.websiteUrl,
        locality: businesses.locality,
        countryCode: businesses.countryCode,
        path: categories.path,
        labels: categories.labels,
      })
      .from(businesses)
      .leftJoin(categories, eq(categories.id, businesses.primaryCategoryId))
      .where(eq(businesses.id, businessId));
    if (!business) return undefined;
    const [[crawl], [insights], [audit], [settings]] = await Promise.all([
      x
        .select({ languages: websiteSnapshots.languages, images: websiteSnapshots.imageCandidates })
        .from(websiteSnapshots)
        .where(eq(websiteSnapshots.businessId, businessId))
        .orderBy(desc(websiteSnapshots.fetchedAt))
        .limit(1),
      x
        .select({ painCounts: reviewInsights.painCounts })
        .from(reviewInsights)
        .where(
          and(eq(reviewInsights.organizationId, organizationId), eq(reviewInsights.businessId, businessId)),
        ),
      x
        .select({ findings: websiteAudits.findings })
        .from(websiteAudits)
        .where(and(eq(websiteAudits.businessId, businessId), eq(websiteAudits.isLatest, true)))
        .limit(1),
      x
        .select({ locales: orgSettings.locales })
        .from(orgSettings)
        .where(eq(orgSettings.organizationId, organizationId)),
    ]);
    const languages = crawl?.languages;
    const images = crawl?.images ?? [];
    return {
      businessName: business.name,
      category: business.path && business.labels ? { path: business.path, labels: business.labels } : null,
      locality: business.locality,
      countryCode: business.countryCode,
      hasWebsite: Boolean(business.websiteUrl),
      siteLanguages: [...new Set([...(languages?.detected ?? []), ...(languages?.declared ?? [])])].map(
        (lang) => lang.slice(0, 2).toLowerCase(),
      ),
      reviewThemes: Object.fromEntries(
        Object.entries(insights?.painCounts ?? {}).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      ),
      findings: (audit?.findings ?? []).flatMap((finding) => {
        const definition = FINDING_DEFINITIONS[finding.code as FindingCode];
        if (!definition) return [];
        return [
          {
            code: finding.code,
            severity: finding.severity,
            recommendation: definition.recommendation.en,
            offers: [...definition.offers],
          },
        ];
      }),
      workspaceLocales: settings?.locales ?? [],
      images: {
        count: images.length,
        large: images.filter((image) => (image.width ?? 0) >= LARGE).length,
      },
    };
  }
}
