import type { Provenance, RegistryFact, RegistryFactKind, SourceProvider } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businessCategories,
  businessContacts,
  businesses,
  businessHours,
  categories,
  factRegistrySnapshots,
  orgBusinesses,
  orgBusinessFacts,
  websiteSnapshots,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type {
  FactOverlayRepository,
  FactSnapshotStore,
  FactSourcesReader,
  StoredOverlayFact,
} from '../application/facts.ports.ts';
import { sourceOfProvider } from '../domain/facts/fact-usage.ts';
import type { Observation } from '../domain/facts/registry.ts';

// The fact registry's adapters (BF-040). Observations come from the golden record (its fields' provenance), the
// contacts and hours (each with its provider), the primary category and the latest crawl of the business's website.
// DECISION(BF-040): the crawl's JSON-LD is not stored on `website_snapshots`, so no `jsonld` facts yet; the
// owner-site extraction of part 2 reads the pages.

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const LOGO_RANK = { 'img-logo': 0, 'og:image': 1, 'link-icon': 2 } as const;

const iso = (date: Date) => date.toISOString();

function networkOf(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.').at(-2) ?? host;
  } catch {
    return 'social';
  }
}

@Injectable()
export class DrizzleFactSources implements FactSourcesReader {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async tracked(organizationId: string, businessId: string) {
    const [row] = await this.x
      .select({ id: orgBusinesses.businessId })
      .from(orgBusinesses)
      .where(and(eq(orgBusinesses.organizationId, organizationId), eq(orgBusinesses.businessId, businessId)))
      .limit(1);
    return Boolean(row);
  }

  async observations(businessId: string): Promise<Observation[]> {
    const [business] = await this.x
      .select({
        displayName: businesses.displayName,
        websiteUrl: businesses.websiteUrl,
        formattedAddress: businesses.formattedAddress,
        lat: sql<number | null>`ST_Y(${businesses.location}::geometry)`,
        lng: sql<number | null>`ST_X(${businesses.location}::geometry)`,
        shortDescription: businesses.shortDescription,
        attributes: businesses.attributes,
        updatedAt: businesses.updatedAt,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    if (!business) return [];
    const observed: Observation[] = [];
    const golden = (kind: RegistryFactKind, value: unknown, field: string) => {
      if (value === null || value === undefined || value === '') return;
      const provenance = business.attributes[field] as Provenance | undefined;
      observed.push({
        kind,
        value,
        source: provenance ? sourceOfProvider(provenance.source) : 'golden_record',
        sourceRef: provenance?.sourceRef
          ? `${provenance.source}:${provenance.sourceRef}`
          : `businesses.${field}`,
        confidence: provenance?.confidence ?? 0.5,
        observedAt: provenance?.observedAt ?? iso(business.updatedAt),
      });
    };
    golden('name', business.displayName, 'displayName');
    golden('website', business.websiteUrl, 'websiteUrl');
    golden('address', business.formattedAddress, 'address');
    if (business.lat !== null && business.lng !== null)
      golden('geo', { lat: business.lat, lng: business.lng }, 'location');
    // A summary we wrote from the site (BF-026), not the business's own words: it guides, it is not stated.
    if (business.shortDescription)
      observed.push({
        kind: 'about_summary',
        value: business.shortDescription,
        source: 'golden_record',
        sourceRef: 'businesses.shortDescription',
        confidence: 0.6,
        observedAt: iso(business.updatedAt),
      });

    const [contacts, hours, category, snapshot] = await Promise.all([
      this.x.select().from(businessContacts).where(eq(businessContacts.businessId, businessId)),
      this.x
        .select()
        .from(businessHours)
        .where(eq(businessHours.businessId, businessId))
        .orderBy(asc(businessHours.weekday), asc(businessHours.opensAt)),
      this.x
        .select({ path: categories.path, confidence: businessCategories.confidence })
        .from(businessCategories)
        .innerJoin(categories, eq(categories.id, businessCategories.categoryId))
        .where(and(eq(businessCategories.businessId, businessId), eq(businessCategories.isPrimary, true)))
        .limit(1),
      this.x
        .select({
          url: websiteSnapshots.url,
          finalUrl: websiteSnapshots.finalUrl,
          fetchedAt: websiteSnapshots.fetchedAt,
          socials: websiteSnapshots.socials,
          logoCandidates: websiteSnapshots.logoCandidates,
        })
        .from(websiteSnapshots)
        .where(eq(websiteSnapshots.businessId, businessId))
        .orderBy(desc(websiteSnapshots.fetchedAt))
        .limit(1),
    ]);

    for (const contact of contacts) {
      if (contact.type === 'website_form' || contact.verificationStatus === 'invalid') continue;
      const kind: RegistryFactKind = contact.type;
      const value =
        contact.type === 'social'
          ? {
              network: contact.subtype !== 'unknown' ? contact.subtype : networkOf(contact.value),
              url: contact.value,
            }
          : contact.type === 'email'
            ? contact.normalizedValue
            : contact.value;
      observed.push({
        kind,
        value,
        source: contact.publishedOnSite ? 'owner_site' : sourceOfProvider(contact.source),
        sourceRef: contact.sourceUrl ?? `business_contacts:${contact.id}`,
        confidence: contact.confidence,
        observedAt: iso(contact.lastSeenAt),
      });
    }

    const bySource = new Map<SourceProvider, typeof hours>();
    for (const row of hours) bySource.set(row.source, [...(bySource.get(row.source) ?? []), row]);
    for (const [source, rows] of bySource)
      observed.push({
        kind: 'hours',
        value: {
          weekly: rows.map((row) => ({
            day: WEEKDAYS[row.weekday] ?? 'mon',
            opens: row.opensAt.slice(0, 5),
            closes: row.closesAt.slice(0, 5),
          })),
        },
        source: sourceOfProvider(source),
        sourceRef: `business_hours:${source}`,
        confidence: 0.8,
        observedAt: iso(business.updatedAt),
      });

    const [primary] = category;
    if (primary)
      observed.push({
        kind: 'category',
        value: primary.path,
        source: 'golden_record',
        sourceRef: 'business_categories.primary',
        confidence: primary.confidence,
        observedAt: iso(business.updatedAt),
      });

    const [crawl] = snapshot;
    if (crawl) {
      const page = crawl.finalUrl ?? crawl.url;
      const seen = { source: 'owner_site' as const, confidence: 0.9, observedAt: iso(crawl.fetchedAt) };
      for (const social of crawl.socials)
        observed.push({
          ...seen,
          kind: 'social',
          value: { network: social.network, url: social.url },
          sourceRef: page,
        });
      const [logo] = [...crawl.logoCandidates].sort((a, b) => LOGO_RANK[a.source] - LOGO_RANK[b.source]);
      if (logo) observed.push({ ...seen, kind: 'logo', value: logo.url, sourceRef: page, confidence: 0.7 });
    }
    return observed;
  }
}

const overlayColumns = {
  id: orgBusinessFacts.id,
  organizationId: orgBusinessFacts.organizationId,
  businessId: orgBusinessFacts.businessId,
  kind: orgBusinessFacts.kind,
  value: orgBusinessFacts.value,
  locale: orgBusinessFacts.locale,
  note: orgBusinessFacts.note,
  createdBy: orgBusinessFacts.createdBy,
  createdAt: orgBusinessFacts.createdAt,
  updatedAt: orgBusinessFacts.updatedAt,
};

const asStored = (row: { kind: string } & Omit<StoredOverlayFact, 'kind'>): StoredOverlayFact => ({
  ...row,
  kind: row.kind as RegistryFactKind,
});

@Injectable()
export class DrizzleFactOverlay implements FactOverlayRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  private live(organizationId: string, businessId: string) {
    return and(
      eq(orgBusinessFacts.organizationId, organizationId),
      eq(orgBusinessFacts.businessId, businessId),
      isNull(orgBusinessFacts.deletedAt),
    );
  }

  async list(organizationId: string, businessId: string) {
    const rows = await this.x
      .select(overlayColumns)
      .from(orgBusinessFacts)
      .where(this.live(organizationId, businessId))
      .orderBy(asc(orgBusinessFacts.createdAt), asc(orgBusinessFacts.id));
    return rows.map(asStored);
  }

  async get(organizationId: string, businessId: string, id: string) {
    const [row] = await this.x
      .select(overlayColumns)
      .from(orgBusinessFacts)
      .where(and(this.live(organizationId, businessId), eq(orgBusinessFacts.id, id)));
    return row ? asStored(row) : undefined;
  }

  async insert(fact: Omit<StoredOverlayFact, 'createdAt' | 'updatedAt'>, at: Date) {
    const [row] = await this.x
      .insert(orgBusinessFacts)
      .values({ ...fact, createdAt: at, updatedAt: at })
      .returning(overlayColumns);
    if (!row) throw new Error('The fact was not stored');
    return asStored(row);
  }

  async update(
    organizationId: string,
    id: string,
    changes: Partial<Pick<StoredOverlayFact, 'value' | 'locale' | 'note'>>,
    at: Date,
  ) {
    const [row] = await this.x
      .update(orgBusinessFacts)
      .set({ ...changes, updatedAt: at })
      .where(
        and(
          eq(orgBusinessFacts.organizationId, organizationId),
          eq(orgBusinessFacts.id, id),
          isNull(orgBusinessFacts.deletedAt),
        ),
      )
      .returning(overlayColumns);
    return row ? asStored(row) : undefined;
  }

  async remove(organizationId: string, businessId: string, id: string, at: Date) {
    const rows = await this.x
      .update(orgBusinessFacts)
      .set({ deletedAt: at, updatedAt: at })
      .where(and(this.live(organizationId, businessId), eq(orgBusinessFacts.id, id)))
      .returning({ id: orgBusinessFacts.id });
    return rows.length > 0;
  }
}

@Injectable()
export class DrizzleFactSnapshots implements FactSnapshotStore {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  private get x() {
    return getExecutor(this.db);
  }

  async save(input: Parameters<FactSnapshotStore['save']>[0]) {
    const [inserted] = await this.x
      .insert(factRegistrySnapshots)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        contentHash: input.contentHash,
        facts: [...input.facts],
        stats: input.stats,
      })
      .onConflictDoNothing()
      .returning({ id: factRegistrySnapshots.id });
    if (inserted) return inserted.id;
    const [existing] = await this.x
      .select({ id: factRegistrySnapshots.id })
      .from(factRegistrySnapshots)
      .where(
        and(
          eq(factRegistrySnapshots.organizationId, input.organizationId),
          eq(factRegistrySnapshots.businessId, input.businessId),
          eq(factRegistrySnapshots.contentHash, input.contentHash),
        ),
      );
    if (!existing) throw new Error('The fact snapshot was neither stored nor found');
    return existing.id;
  }

  async load(organizationId: string, id: string) {
    const [row] = await this.x
      .select({ facts: factRegistrySnapshots.facts })
      .from(factRegistrySnapshots)
      .where(and(eq(factRegistrySnapshots.organizationId, organizationId), eq(factRegistrySnapshots.id, id)));
    return row ? (row.facts as RegistryFact[]) : undefined;
  }
}
