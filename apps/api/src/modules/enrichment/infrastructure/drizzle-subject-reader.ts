import { type DbClient, getExecutor } from '@bf/db';
import { businessContacts, businesses, orgBusinesses } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, exists, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { SubjectReader } from '../application/ports.ts';
import type { EnrichmentSubject } from '../domain/enrichment-step.ts';

/** French-speaking countries: their sites are read with French first (key-page words, phone formats). */
const FRENCH = new Set([
  'FR',
  'BL',
  'MF',
  'GP',
  'MQ',
  'GF',
  'RE',
  'YT',
  'PM',
  'NC',
  'PF',
  'WF',
  'BE',
  'CH',
  'LU',
  'MC',
]);

/**
 * Reads the golden record (read-only) as enrichment steps see it.
 * DECISION(BF-027): read-only queries on business-graph and crm tables (as search does) — a cross-module read model;
 * writes go through business-graph commands (ingestion, website media).
 */
@Injectable()
export class DrizzleSubjectReader implements SubjectReader {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async subject(businessId: string): Promise<EnrichmentSubject | undefined> {
    const [subject] = await this.load(eq(businesses.id, businessId));
    return subject;
  }

  async trackedSubjects(
    organizationId: string,
    businessIds: readonly string[],
  ): Promise<EnrichmentSubject[]> {
    if (businessIds.length === 0) return [];
    return this.load(
      and(
        inArray(businesses.id, [...businessIds]),
        exists(
          getExecutor(this.db)
            .select({ one: sql`1` })
            .from(orgBusinesses)
            .where(
              and(
                eq(orgBusinesses.organizationId, organizationId),
                eq(orgBusinesses.businessId, businesses.id),
              ),
            ),
        ),
      ) as SQL,
    );
  }

  private async load(where: SQL): Promise<EnrichmentSubject[]> {
    const x = getExecutor(this.db);
    const rows = await x
      .select({
        id: businesses.id,
        displayName: businesses.displayName,
        websiteUrl: businesses.websiteUrl,
        countryCode: businesses.countryCode,
      })
      .from(businesses)
      .where(and(where, isNull(businesses.mergedIntoId)));
    if (rows.length === 0) return [];
    const emails = await x
      .select({ businessId: businessContacts.businessId, value: businessContacts.normalizedValue })
      .from(businessContacts)
      .where(
        and(
          inArray(
            businessContacts.businessId,
            rows.map((r) => r.id),
          ),
          eq(businessContacts.type, 'email'),
        ),
      );
    return rows.map((row) => ({
      businessId: row.id,
      displayName: row.displayName,
      websiteUrl: row.websiteUrl,
      countryCode: row.countryCode,
      locales: row.countryCode && FRENCH.has(row.countryCode) ? ['fr', 'en'] : ['en'],
      emails: emails.filter((e) => e.businessId === row.id).map((e) => e.value),
    }));
  }

  async tracks(organizationId: string, businessId: string): Promise<boolean> {
    const [row] = await getExecutor(this.db)
      .select({ id: orgBusinesses.businessId })
      .from(orgBusinesses)
      .where(and(eq(orgBusinesses.organizationId, organizationId), eq(orgBusinesses.businessId, businessId)));
    return row !== undefined;
  }
}
