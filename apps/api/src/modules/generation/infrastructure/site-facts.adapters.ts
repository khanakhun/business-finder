import {
  type AiGateway,
  type ExtractSiteFactsOutput,
  GenerationExtractSiteFacts,
  type VerifiedSiteFact,
} from '@bf/ai';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businessCategories,
  businesses,
  categories,
  siteFactExtractions,
  websiteSnapshots,
} from '@bf/db/schema';
import { metrics } from '@bf/observability';
import { and, desc, eq } from 'drizzle-orm';
import type { CountryCode } from 'libphonenumber-js/max';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type {
  CrawledPage,
  ExtractionStats,
  SiteFactExtractionStore,
  SiteFactExtractor,
  SiteFactTelemetry,
  SitePagesReader,
  StoredExtraction,
} from '../application/facts.ports.ts';
import type { ArtifactStore } from '../application/ports.ts';

// Adapters of the owner-site extraction (BF-040): the latest crawl's pages (markdown from the artifacts bucket), the
// model through the AI gateway (budgets, ledger, cache), the verified facts in Postgres and their metrics.

/** Bytes of one page's markdown read from storage (the prompt keeps far less). */
const MAX_MARKDOWN_BYTES = 256 * 1024;

export class DrizzleSitePages implements SitePagesReader {
  constructor(
    private readonly db: DbClient,
    private readonly artifacts: Pick<ArtifactStore, 'get'>,
  ) {}

  async latest(businessId: string) {
    const x = getExecutor(this.db);
    const [crawl] = await x
      .select({
        id: websiteSnapshots.id,
        fetchedAt: websiteSnapshots.fetchedAt,
        pages: websiteSnapshots.pages,
        businessName: businesses.displayName,
      })
      .from(websiteSnapshots)
      .innerJoin(businesses, eq(businesses.id, websiteSnapshots.businessId))
      .where(eq(websiteSnapshots.businessId, businessId))
      .orderBy(desc(websiteSnapshots.fetchedAt))
      .limit(1);
    if (!crawl) return undefined;
    const [category] = await x
      .select({ labels: categories.labels })
      .from(businessCategories)
      .innerJoin(categories, eq(categories.id, businessCategories.categoryId))
      .where(and(eq(businessCategories.businessId, businessId), eq(businessCategories.isPrimary, true)))
      .limit(1);
    const pages: CrawledPage[] = [];
    for (const page of crawl.pages ?? []) {
      if (!page.markdownKey) continue;
      const body = await this.artifacts.get(page.markdownKey);
      if (!body) continue;
      pages.push({
        url: page.url,
        kind: page.kind,
        lang: page.lang,
        markdown: body.subarray(0, MAX_MARKDOWN_BYTES).toString('utf8'),
      });
    }
    return {
      snapshotId: crawl.id,
      fetchedAt: crawl.fetchedAt,
      businessName: crawl.businessName,
      categoryLabel: category?.labels.en ?? null,
      pages,
    };
  }
}

export class GatewaySiteFactExtractor implements SiteFactExtractor {
  constructor(private readonly gateway: AiGateway) {}

  async extract(organizationId: string, input: Parameters<SiteFactExtractor['extract']>[1]) {
    const result = await this.gateway.run(GenerationExtractSiteFacts, input, { orgId: organizationId });
    return { output: result.output as ExtractSiteFactsOutput, model: result.model };
  }
}

export class DrizzleSiteFactExtractions implements SiteFactExtractionStore {
  constructor(private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  private static stored(row: typeof siteFactExtractions.$inferSelect): StoredExtraction {
    return {
      id: row.id,
      businessId: row.businessId,
      snapshotId: row.snapshotId,
      inputHash: row.inputHash,
      model: row.model,
      facts: row.facts as VerifiedSiteFact[],
      stats: row.stats as unknown as ExtractionStats,
      observedAt: row.observedAt,
    };
  }

  async find(businessId: string, inputHash: string) {
    const [row] = await this.x
      .select()
      .from(siteFactExtractions)
      .where(
        and(eq(siteFactExtractions.businessId, businessId), eq(siteFactExtractions.inputHash, inputHash)),
      );
    return row ? DrizzleSiteFactExtractions.stored(row) : undefined;
  }

  async latest(businessId: string) {
    const [row] = await this.x
      .select()
      .from(siteFactExtractions)
      .where(eq(siteFactExtractions.businessId, businessId))
      .orderBy(desc(siteFactExtractions.observedAt), desc(siteFactExtractions.createdAt))
      .limit(1);
    return row ? DrizzleSiteFactExtractions.stored(row) : undefined;
  }

  async save(extraction: Omit<StoredExtraction, 'id'>) {
    await this.x
      .insert(siteFactExtractions)
      .values({
        businessId: extraction.businessId,
        snapshotId: extraction.snapshotId,
        inputHash: extraction.inputHash,
        model: extraction.model,
        facts: [...extraction.facts],
        stats: extraction.stats as unknown as Record<string, unknown>,
        observedAt: extraction.observedAt,
      })
      .onConflictDoNothing();
  }
}

const candidatesTotal = () =>
  metrics.counter({
    name: 'bf_site_fact_candidates_total',
    help: 'Owner-site fact candidates by verification outcome (accepted or the rejection reason)',
    labelNames: ['outcome'],
  });

export const PROMETHEUS_SITE_FACT_TELEMETRY: SiteFactTelemetry = {
  verified(stats) {
    if (stats.accepted > 0) candidatesTotal().inc({ outcome: 'accepted' }, stats.accepted);
    for (const [reason, count] of Object.entries(stats.rejected))
      if (count) candidatesTotal().inc({ outcome: reason }, count);
  },
};

/** E.164 when the number reads as valid (national formats in the business's country), else the text as written. */
export function phoneE164(raw: string, country: string | null): string {
  const parsed = parsePhoneNumberFromString(raw, (country?.toUpperCase() as CountryCode | undefined) ?? 'BL');
  return parsed?.isValid() ? parsed.number : raw;
}
