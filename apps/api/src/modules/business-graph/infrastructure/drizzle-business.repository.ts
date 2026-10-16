import type { SourceProvider } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businessContacts, businesses, businessSources } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { BusinessRepository } from '../application/ports.ts';
import { Business, type BusinessState } from '../domain/business.entity.ts';
import type { BusinessContactProps } from '../domain/business-contact.ts';
import { ConcurrentModificationError } from '../domain/errors.ts';

type BusinessRow = typeof businesses.$inferSelect;

export const toBusinessState = (row: BusinessRow): BusinessState => ({
  id: row.id,
  displayName: row.displayName,
  normalizedName: row.normalizedName,
  primaryCategoryId: row.primaryCategoryId,
  operatingStatus: row.operatingStatus,
  websiteUrl: row.websiteUrl,
  websiteHost: row.websiteHost,
  websiteRegistrableDomain: row.websiteRegistrableDomain,
  primaryPhoneE164: row.primaryPhoneE164,
  countryCode: row.countryCode,
  localeHint: row.localeHint,
  location: row.location,
  address: row.address,
  formattedAddress: row.formattedAddress,
  locality: row.locality,
  postalCode: row.postalCode,
  priceLevel: row.priceLevel,
  ratingAvg: row.ratingAvg,
  ratingCount: row.ratingCount,
  attributes: row.attributes,
  dataQuality: row.dataQuality,
  mergedIntoId: row.mergedIntoId,
  version: row.version,
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
});

const toColumns = (state: BusinessState) => ({
  displayName: state.displayName,
  normalizedName: state.normalizedName,
  primaryCategoryId: state.primaryCategoryId,
  operatingStatus: state.operatingStatus,
  websiteUrl: state.websiteUrl,
  websiteHost: state.websiteHost,
  websiteRegistrableDomain: state.websiteRegistrableDomain,
  primaryPhoneE164: state.primaryPhoneE164,
  countryCode: state.countryCode,
  localeHint: state.localeHint,
  location: state.location,
  address: state.address,
  formattedAddress: state.formattedAddress,
  locality: state.locality,
  postalCode: state.postalCode,
  priceLevel: state.priceLevel,
  ratingAvg: state.ratingAvg,
  ratingCount: state.ratingCount,
  attributes: state.attributes,
  dataQuality: state.dataQuality,
  mergedIntoId: state.mergedIntoId,
  firstSeenAt: state.firstSeenAt,
  lastSeenAt: state.lastSeenAt,
});

@Injectable()
export class DrizzleBusinessRepository implements BusinessRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async getById(id: string): Promise<Business | undefined> {
    const [row] = await getExecutor(this.db).select().from(businesses).where(eq(businesses.id, id));
    return row ? Business.rehydrate(toBusinessState(row)) : undefined;
  }

  async getByIds(ids: readonly string[]): Promise<Business[]> {
    if (ids.length === 0) return [];
    const rows = await getExecutor(this.db)
      .select()
      .from(businesses)
      .where(inArray(businesses.id, [...ids]));
    return rows.map((row) => Business.rehydrate(toBusinessState(row)));
  }

  async findBySourceRef(provider: SourceProvider, providerRef: string): Promise<Business | undefined> {
    const [row] = await getExecutor(this.db)
      .select({ business: businesses })
      .from(businessSources)
      .innerJoin(businesses, eq(businesses.id, businessSources.businessId))
      .where(and(eq(businessSources.provider, provider), eq(businessSources.providerRef, providerRef)));
    return row ? Business.rehydrate(toBusinessState(row.business)) : undefined;
  }

  async save(business: Business): Promise<void> {
    const state = business.snapshot();
    const executor = getExecutor(this.db);
    let version = state.version;
    if (business.isNew) {
      await executor.insert(businesses).values({ id: state.id, ...toColumns(state), version: 1 });
      version = 1;
    } else if (business.hasRowChanges) {
      const [row] = await executor
        .update(businesses)
        .set({ ...toColumns(state), version: sql`${businesses.version} + 1` })
        .where(and(eq(businesses.id, state.id), eq(businesses.version, state.version)))
        .returning({ version: businesses.version });
      if (!row) throw new ConcurrentModificationError('Business', state.id);
      version = row.version;
    }
    // Contacts alone leave the row (and its version) alone: their upsert is idempotent and safe concurrently.
    await this.insertContacts(business.pullNewContacts());
    business.markSaved(version);
  }

  /**
   * A contact seen again keeps its id, first sighting and first source; its confidence only rises and it becomes
   * `published_on_site` once any source saw it on the business's site.
   */
  private async insertContacts(contacts: readonly BusinessContactProps[]): Promise<void> {
    // One row per key: ON CONFLICT DO UPDATE cannot touch the same row twice in one statement.
    const unique = [
      ...new Map(contacts.map((c) => [`${c.type}\u0000${c.normalizedValue.toLowerCase()}`, c])).values(),
    ];
    if (unique.length === 0) return;
    await getExecutor(this.db)
      .insert(businessContacts)
      .values(unique.map((contact) => ({ ...contact })))
      .onConflictDoUpdate({
        target: [businessContacts.businessId, businessContacts.type, businessContacts.normalizedValue],
        set: {
          lastSeenAt: sql`now()`,
          confidence: sql`GREATEST(${businessContacts.confidence}, excluded.confidence)`,
          publishedOnSite: sql`${businessContacts.publishedOnSite} OR excluded.published_on_site`,
          sourceUrl: sql`COALESCE(${businessContacts.sourceUrl}, excluded.source_url)`,
          // The latest crawl knows best where the site shows it now; other sources leave it alone.
          publishedContext: sql`COALESCE(excluded.published_context, ${businessContacts.publishedContext})`,
          isFreeMail: sql`COALESCE(excluded.is_free_mail, ${businessContacts.isFreeMail})`,
        },
      });
  }
}
