import type { ExtractSiteFactsInput, ExtractSiteFactsOutput, SiteFactCandidate } from '@bf/ai';
import { describe, expect, it } from 'vitest';
import type {
  CrawledPage,
  ExtractionStats,
  SiteFactExtractionStore,
  SiteFactExtractor,
  StoredExtraction,
} from './facts.ports.ts';
import { choosePages, SiteFactExtraction } from './site-facts.extraction.ts';

const page = (kind: string, markdown: string, url = `https://salon.example/${kind}`): CrawledPage => ({
  url,
  kind,
  lang: 'fr',
  markdown,
});

const candidate = (overrides: Partial<SiteFactCandidate>): SiteFactCandidate => ({
  kind: 'service',
  pageId: 'p1',
  locale: 'fr',
  evidence: '',
  text: null,
  price: null,
  hours: null,
  testimonial: null,
  person: null,
  year: null,
  booking: null,
  ...overrides,
});

class Store implements SiteFactExtractionStore {
  readonly rows: StoredExtraction[] = [];
  async find(businessId: string, inputHash: string) {
    return this.rows.find((row) => row.businessId === businessId && row.inputHash === inputHash);
  }
  async latest(businessId: string) {
    return this.rows.filter((row) => row.businessId === businessId).at(-1);
  }
  async save(extraction: Omit<StoredExtraction, 'id'>) {
    if (!(await this.find(extraction.businessId, extraction.inputHash)))
      this.rows.push({ ...extraction, id: `x${this.rows.length}` });
  }
}

class Extractor implements SiteFactExtractor {
  readonly inputs: ExtractSiteFactsInput[] = [];
  constructor(private readonly output: ExtractSiteFactsOutput) {}
  async extract(_organizationId: string, input: ExtractSiteFactsInput) {
    this.inputs.push(input);
    return { output: this.output, model: 'fake-model' };
  }
}

describe('choosePages', () => {
  it('keeps the pages that state facts, best first, never legal pages, at most six', () => {
    const chosen = choosePages([
      page('legal', 'Mentions légales'),
      page('other', 'Blog'),
      page('contact', 'Contact'),
      page('home', 'Accueil'),
      page('services', '  '),
      ...Array.from({ length: 6 }, (_, i) => page('other', `Page ${i}`, `https://salon.example/o${i}`)),
    ]);
    expect(chosen.map((p) => p.kind)).toEqual(['home', 'contact', 'other', 'other', 'other', 'other']);
    expect(chosen[2]?.markdown).toBe('Blog');
  });
});

describe('SiteFactExtraction', () => {
  const crawl = {
    snapshotId: 'snap-1',
    fetchedAt: new Date('2026-10-10T09:00:00Z'),
    businessName: 'Salon Corail',
    categoryLabel: 'Hair salon',
    pages: [page('home', 'Salon Corail. Coupe femme 45 € — du mardi au samedi 9h-18h.')],
  };
  const output: ExtractSiteFactsOutput = {
    candidates: [
      candidate({ kind: 'service', text: 'Coupe femme', evidence: 'Coupe femme 45 €' }),
      candidate({
        kind: 'price',
        evidence: 'Coupe femme 45 €',
        price: { amount: 54, currency: 'EUR', unit: null, item: 'Coupe femme' },
      }),
      candidate({ kind: 'service', text: 'Barbier', evidence: 'Barbier et rasage à l’ancienne' }),
    ],
    warnings: [],
  };

  it('extracts once per content, stores only verified facts and reports the rejections', async () => {
    const store = new Store();
    const extractor = new Extractor(output);
    const seen: ExtractionStats[] = [];
    const service = new SiteFactExtraction({ latest: async () => crawl }, extractor, store, {
      verified: (stats) => seen.push(stats),
    });
    const first = await service.extract('org', 'biz');
    expect(first).toEqual({
      status: 'extracted',
      stats: {
        pages: 1,
        candidates: 3,
        accepted: 1,
        rejected: { number_not_in_evidence: 1, evidence_not_on_page: 1 },
        warnings: 0,
      },
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.facts.map((fact) => [fact.kind, fact.value])).toEqual([['service', 'Coupe femme']]);
    expect(store.rows[0]).toMatchObject({
      snapshotId: 'snap-1',
      model: 'fake-model',
      observedAt: crawl.fetchedAt,
    });
    expect(extractor.inputs[0]).toMatchObject({
      businessName: 'Salon Corail',
      businessCategory: 'Hair salon',
      pages: [{ id: 'p1', kind: 'home', url: 'https://salon.example/home' }],
    });

    const again = await service.extract('org', 'biz');
    expect(again.status).toBe('cached');
    expect(extractor.inputs).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('skips a business without a crawl or without pages', async () => {
    const extractor = new Extractor(output);
    const telemetry = { verified: () => {} };
    expect(
      await new SiteFactExtraction(
        { latest: async () => undefined },
        extractor,
        new Store(),
        telemetry,
      ).extract('org', 'biz'),
    ).toEqual({ status: 'skipped', reason: 'no_crawl' });
    expect(
      await new SiteFactExtraction(
        { latest: async () => ({ ...crawl, pages: [page('legal', 'CGV')] }) },
        extractor,
        new Store(),
        telemetry,
      ).extract('org', 'biz'),
    ).toEqual({ status: 'skipped', reason: 'no_pages' });
    expect(extractor.inputs).toHaveLength(0);
  });
});
