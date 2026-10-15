import type { ContactType, MatchScore, SourceProvider } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businessCategories,
  businessContacts,
  businesses,
  businessHours,
  businessSources,
  categories,
  possibleDuplicates,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../../platform/db/db.module.ts';
import type { LinkedSource, ResolutionRepository } from '../../application/resolution/ports.ts';
import { BLOCKING } from '../../domain/resolution/blocking.ts';
import { addressTokens, type CandidateProfile } from '../../domain/resolution/match-scorer.ts';
import type { NormalizedSource } from '../../domain/resolution/normalized-source.ts';
import { WebsiteUrl } from '../../domain/value-objects/website-url.ts';

/** `ARRAY[$1, $2, …]::<type>[]` (Drizzle would expand a JS array into a row, not an array). */
const arrayOf = (values: readonly string[], type: 'text' | 'citext') =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::${sql.raw(type)}[]`;

const siteKeyOf = (url: string | null): string[] => {
  if (!url) return [];
  try {
    return [WebsiteUrl.parse(url).matchKey];
  } catch {
    return [];
  }
};

@Injectable()
export class DrizzleResolutionRepository implements ResolutionRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async lockKeys(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    // One statement, locks taken in array order (keys arrive sorted): concurrent ingestions cannot deadlock.
    await getExecutor(this.db).execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(k, 0)) FROM unnest(${arrayOf(keys, 'text')}) WITH ORDINALITY AS t(k, n) ORDER BY n`,
    );
  }

  async findCandidateIds(source: NormalizedSource, limit: number): Promise<string[]> {
    const phones = source.phones.map((p) => p.e164);
    const point = source.location
      ? sql`ST_SetSRID(ST_MakePoint(${source.location.lng}, ${source.location.lat}), 4326)::geography`
      : null;
    const live = sql`b.merged_into_id IS NULL`;
    const branches = [];
    if (phones.length > 0) {
      branches.push(
        sql`SELECT b.id FROM businesses b WHERE ${live} AND b.primary_phone_e164 = ANY(${arrayOf(phones, 'text')})`,
      );
      branches.push(
        sql`SELECT c.business_id AS id FROM business_contacts c JOIN businesses b ON b.id = c.business_id
            WHERE ${live} AND c.type = 'phone' AND c.normalized_value = ANY(${arrayOf(phones, 'citext')})`,
      );
    }
    if (source.website && !source.website.shared) {
      branches.push(
        sql`SELECT b.id FROM businesses b WHERE ${live} AND b.website_registrable_domain = ${source.website.registrableDomain}`,
      );
    } else if (source.website) {
      branches.push(
        sql`SELECT b.id FROM businesses b WHERE ${live} AND b.website_url = ${source.website.canonical}`,
      );
    }
    if (point) {
      branches.push(
        sql`SELECT b.id FROM businesses b WHERE ${live} AND ST_DWithin(b.location, ${point}, ${BLOCKING.nearRadiusMeters})
            AND similarity(b.normalized_name, ${source.name.normalized}) >= ${BLOCKING.minNameSimilarity}`,
      );
      branches.push(
        sql`SELECT b.id FROM businesses b WHERE ${live} AND b.normalized_name = ${source.name.normalized}
            AND ST_DWithin(b.location, ${point}, ${BLOCKING.sameNameRadiusMeters})`,
      );
    } else {
      branches.push(
        sql`SELECT b.id FROM businesses b WHERE ${live} AND b.normalized_name = ${source.name.normalized}`,
      );
    }
    const union = sql.join(
      branches.map((b) => sql`(${b} LIMIT ${limit})`),
      sql` UNION `,
    );
    const rows = await getExecutor(this.db).execute<{ id: string }>(
      sql`SELECT id FROM (${union}) AS candidates ORDER BY id LIMIT ${limit}`,
    );
    return rows.map((r) => r.id);
  }

  async loadProfiles(businessIds: readonly string[]): Promise<CandidateProfile[]> {
    if (businessIds.length === 0) return [];
    const ids = [...businessIds];
    const executor = getExecutor(this.db);
    const [rows, phones, sources] = await Promise.all([
      executor
        .select({
          id: businesses.id,
          normalizedName: businesses.normalizedName,
          location: businesses.location,
          primaryPhone: businesses.primaryPhoneE164,
          websiteUrl: businesses.websiteUrl,
          formattedAddress: businesses.formattedAddress,
          categoryPath: categories.path,
        })
        .from(businesses)
        .leftJoin(categories, eq(categories.id, businesses.primaryCategoryId))
        .where(inArray(businesses.id, ids)),
      executor
        .select({ businessId: businessContacts.businessId, value: businessContacts.normalizedValue })
        .from(businessContacts)
        .where(and(inArray(businessContacts.businessId, ids), eq(businessContacts.type, 'phone'))),
      executor
        .select({
          businessId: businessSources.businessId,
          provider: businessSources.provider,
          providerRef: businessSources.providerRef,
        })
        .from(businessSources)
        .where(inArray(businessSources.businessId, ids)),
    ]);
    return rows.map((row) => ({
      businessId: row.id,
      normalizedName: row.normalizedName,
      location: row.location,
      phones: [
        ...new Set([
          ...(row.primaryPhone ? [row.primaryPhone] : []),
          ...phones.filter((p) => p.businessId === row.id).map((p) => p.value),
        ]),
      ],
      siteKeys: siteKeyOf(row.websiteUrl),
      categoryPath: row.categoryPath,
      addressTokens: addressTokens(row.formattedAddress),
      sources: sources
        .filter((s) => s.businessId === row.id)
        .map((s) => ({ provider: s.provider as SourceProvider, providerRef: s.providerRef })),
    }));
  }

  async findSource(provider: string, providerRef: string): Promise<LinkedSource | undefined> {
    const [row] = await getExecutor(this.db)
      .select({
        id: businessSources.id,
        businessId: businessSources.businessId,
        contentHash: businessSources.contentHash,
        normalized: businessSources.normalized,
      })
      .from(businessSources)
      .where(
        and(
          eq(businessSources.provider, provider as SourceProvider),
          eq(businessSources.providerRef, providerRef),
        ),
      );
    return row ? { ...row, normalized: (row.normalized as NormalizedSource | null) ?? null } : undefined;
  }

  async linkSource(
    sourceId: string,
    businessId: string,
    matchConfidence: number,
    linkedBy: 'auto' | 'manual',
  ) {
    await getExecutor(this.db)
      .update(businessSources)
      .set({ businessId, matchConfidence, linkedBy })
      .where(eq(businessSources.id, sourceId));
  }

  async listLinkedSources(businessId: string) {
    const rows = await getExecutor(this.db)
      .select({ id: businessSources.id, normalized: businessSources.normalized })
      .from(businessSources)
      .where(and(eq(businessSources.businessId, businessId), isNotNull(businessSources.normalized)))
      .orderBy(asc(businessSources.id));
    return rows.map((r) => ({ id: r.id, normalized: r.normalized as unknown as NormalizedSource }));
  }

  async touchSource(sourceId: string, fetchedAt: Date, expiresAt: Date | null): Promise<void> {
    await getExecutor(this.db)
      .update(businessSources)
      .set({ fetchedAt, expiresAt })
      .where(eq(businessSources.id, sourceId));
  }

  async replaceHours(
    businessId: string,
    hours: ReadonlyArray<{ weekday: number; opensAt: string; closesAt: string }>,
    source: string,
  ): Promise<boolean> {
    const executor = getExecutor(this.db);
    const current = await executor
      .select({
        weekday: businessHours.weekday,
        opensAt: businessHours.opensAt,
        closesAt: businessHours.closesAt,
      })
      .from(businessHours)
      .where(eq(businessHours.businessId, businessId))
      .orderBy(asc(businessHours.weekday), asc(businessHours.opensAt));
    const key = (h: { weekday: number; opensAt: string; closesAt: string }) =>
      `${h.weekday}-${h.opensAt.slice(0, 5)}-${h.closesAt.slice(0, 5)}`;
    if (current.map(key).join('|') === hours.map(key).join('|')) return false;
    await executor.delete(businessHours).where(eq(businessHours.businessId, businessId));
    if (hours.length > 0) {
      await executor
        .insert(businessHours)
        .values(hours.map((h) => ({ businessId, ...h, source: source as SourceProvider })));
    }
    return true;
  }

  async replaceCategories(
    businessId: string,
    next: ReadonlyArray<{ categoryId: string; isPrimary: boolean; confidence: number; source: string }>,
  ): Promise<boolean> {
    const executor = getExecutor(this.db);
    const current = await executor
      .select({ categoryId: businessCategories.categoryId, isPrimary: businessCategories.isPrimary })
      .from(businessCategories)
      .where(eq(businessCategories.businessId, businessId))
      .orderBy(asc(businessCategories.categoryId));
    const key = (c: { categoryId: string; isPrimary: boolean }) => `${c.categoryId}:${c.isPrimary}`;
    const sorted = [...next].sort((a, b) => a.categoryId.localeCompare(b.categoryId));
    const changed = current.map(key).join('|') !== sorted.map(key).join('|');
    await executor.delete(businessCategories).where(eq(businessCategories.businessId, businessId));
    if (next.length > 0)
      await executor.insert(businessCategories).values(next.map((c) => ({ businessId, ...c })));
    return changed;
  }

  async deleteDerivedContactsExcept(
    businessId: string,
    keep: ReadonlyArray<{ type: ContactType; normalizedValue: string }>,
  ): Promise<number> {
    // `type|value`: contact types never contain `|` (and Postgres text cannot hold NUL bytes).
    const keys = keep.map((k) => `${k.type}|${k.normalizedValue.toLowerCase()}`);
    const rows = await getExecutor(this.db)
      .delete(businessContacts)
      .where(
        and(
          eq(businessContacts.businessId, businessId),
          ne(businessContacts.source, 'manual'),
          keys.length > 0
            ? notInArray(
                sql`${businessContacts.type} || '|' || lower(${businessContacts.normalizedValue}::text)`,
                keys,
              )
            : undefined,
        ),
      )
      .returning({ id: businessContacts.id });
    return rows.length;
  }

  async mergedInto(businessId: string): Promise<string | null | undefined> {
    const [row] = await getExecutor(this.db)
      .select({ mergedIntoId: businesses.mergedIntoId })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    return row ? row.mergedIntoId : undefined;
  }

  async trackedOnlyBy(organizationId: string, businessIds: readonly string[]): Promise<Set<string>> {
    if (businessIds.length === 0) return new Set();
    const rows = await getExecutor(this.db).execute<{ business_id: string }>(sql`
      SELECT business_id FROM org_businesses
      WHERE business_id = ANY(${arrayOf([...businessIds], 'text')}::uuid[])
      GROUP BY business_id
      HAVING bool_and(organization_id = ${organizationId}) AND bool_or(organization_id = ${organizationId})`);
    return new Set(rows.map((r) => r.business_id));
  }

  async recordPossibleDuplicate(businessA: string, businessB: string, score: MatchScore): Promise<void> {
    if (businessA === businessB) return;
    const [a, b] = businessA < businessB ? [businessA, businessB] : [businessB, businessA];
    await getExecutor(this.db)
      .insert(possibleDuplicates)
      .values({
        businessAId: a,
        businessBId: b,
        score: score.total,
        reasons: score as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: [possibleDuplicates.businessAId, possibleDuplicates.businessBId],
        set: { score: sql`excluded.score`, reasons: sql`excluded.reasons` },
        setWhere: sql`${possibleDuplicates.status} = 'open'`,
      });
  }
}
