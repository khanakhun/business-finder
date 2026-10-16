import {
  type ExtractSiteFactsInput,
  GenerationExtractSiteFacts,
  SITE_FACT_PAGE_BUDGET,
  SITE_FACT_PAGES_PER_CALL,
  verifySiteFactCandidates,
} from '@bf/ai';
import { sha256Hex, stableJson } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import {
  type CrawledPage,
  type ExtractionStats,
  SITE_FACT_EXTRACTIONS,
  SITE_FACT_EXTRACTOR,
  SITE_FACT_TELEMETRY,
  SITE_PAGES_READER,
  type SiteFactExtractionStore,
  type SiteFactExtractor,
  type SiteFactTelemetry,
  type SitePagesReader,
} from './facts.ports.ts';

// Owner-site fact extraction (BF-040): the most informative pages of the latest crawl go to the model once per
// distinct content; its candidates are verified deterministically and only the survivors are stored (the rejected
// ones are counted, never kept). The registry then reads them as `owner_site` facts with their evidence.

/** Pages that state facts, best first; legal pages and the rest only when room is left. */
const PAGE_ORDER = ['home', 'about', 'services', 'menu', 'contact', 'booking', 'other'];

export type ExtractionOutcome =
  | { readonly status: 'extracted' | 'cached'; readonly stats: ExtractionStats }
  | { readonly status: 'skipped'; readonly reason: 'no_crawl' | 'no_pages' };

export function choosePages(pages: readonly CrawledPage[]): CrawledPage[] {
  const rank = (kind: string) => {
    const index = PAGE_ORDER.indexOf(kind);
    return index === -1 ? PAGE_ORDER.length : index;
  };
  return pages
    .filter((page) => page.kind !== 'legal' && page.markdown.trim().length > 0)
    .map((page, position) => ({ page, position }))
    .sort((a, b) => rank(a.page.kind) - rank(b.page.kind) || a.position - b.position)
    .slice(0, SITE_FACT_PAGES_PER_CALL)
    .map(({ page }) => page);
}

@Injectable()
export class SiteFactExtraction {
  constructor(
    @Inject(SITE_PAGES_READER) private readonly pages: SitePagesReader,
    @Inject(SITE_FACT_EXTRACTOR) private readonly extractor: SiteFactExtractor,
    @Inject(SITE_FACT_EXTRACTIONS) private readonly store: SiteFactExtractionStore,
    @Inject(SITE_FACT_TELEMETRY) private readonly telemetry: SiteFactTelemetry,
  ) {}

  /** Extracts once per distinct crawl content; the workspace pays (its AI budget) for a new extraction only. */
  async extract(organizationId: string, businessId: string): Promise<ExtractionOutcome> {
    const crawl = await this.pages.latest(businessId);
    if (!crawl) return { status: 'skipped', reason: 'no_crawl' };
    const chosen = choosePages(crawl.pages);
    if (chosen.length === 0) return { status: 'skipped', reason: 'no_pages' };
    const input: ExtractSiteFactsInput = {
      businessName: crawl.businessName.slice(0, 200),
      ...(crawl.categoryLabel ? { businessCategory: crawl.categoryLabel.slice(0, 100) } : {}),
      pages: chosen.map((page, index) => ({
        id: `p${index + 1}`,
        url: page.url,
        kind: page.kind.slice(0, 20),
        lang: page.lang?.slice(0, 35) ?? null,
        markdown: page.markdown.slice(0, SITE_FACT_PAGE_BUDGET),
      })),
    };
    const inputHash = await sha256Hex(stableJson({ prompt: GenerationExtractSiteFacts.prompt, input }));
    const existing = await this.store.find(businessId, inputHash);
    if (existing) return { status: 'cached', stats: existing.stats };

    const { output, model } = await this.extractor.extract(organizationId, input);
    const { accepted, rejected } = verifySiteFactCandidates(output.candidates, input.pages);
    const byReason: Partial<Record<(typeof rejected)[number]['reason'], number>> = {};
    for (const { reason } of rejected) byReason[reason] = (byReason[reason] ?? 0) + 1;
    const stats: ExtractionStats = {
      pages: input.pages.length,
      candidates: output.candidates.length,
      accepted: accepted.length,
      rejected: byReason,
      warnings: output.warnings.length,
    };
    this.telemetry.verified(stats);
    await this.store.save({
      businessId,
      snapshotId: crawl.snapshotId,
      inputHash,
      model,
      facts: accepted,
      stats,
      observedAt: crawl.fetchedAt,
    });
    return { status: 'extracted', stats };
  }
}
