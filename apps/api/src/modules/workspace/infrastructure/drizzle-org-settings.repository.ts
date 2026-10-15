import { type DbClient, getExecutor } from '@bf/db';
import { orgSettings } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { OrgSettingsPatch, OrgSettingsRecord, OrgSettingsRepository } from '../application/ports.ts';

const toRecord = (row: typeof orgSettings.$inferSelect): OrgSettingsRecord => ({
  organizationId: row.organizationId,
  agencyName: row.agencyName,
  legalName: row.legalName,
  postalAddress: row.postalAddress,
  websiteUrl: row.websiteUrl,
  logoAssetKey: row.logoAssetKey,
  logoContentType: row.logoContentType,
  primaryLocale: row.primaryLocale,
  locales: row.locales,
  timezone: row.timezone,
  defaultCountryCode: row.defaultCountryCode,
  senderDefaults: row.senderDefaults,
  discovery: row.discovery,
  enrichment: row.enrichment,
  features: row.features,
  updatedAt: row.updatedAt,
});

@Injectable()
export class DrizzleOrgSettingsRepository implements OrgSettingsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async find(organizationId: string): Promise<OrgSettingsRecord | undefined> {
    const [row] = await getExecutor(this.db)
      .select()
      .from(orgSettings)
      .where(eq(orgSettings.organizationId, organizationId));
    return row ? toRecord(row) : undefined;
  }

  async upsert(
    organizationId: string,
    patch: OrgSettingsPatch,
    updatedBy: string | null,
  ): Promise<OrgSettingsRecord> {
    const values = {
      ...patch,
      locales: patch.locales ? [...patch.locales] : undefined,
      updatedBy,
    };
    const defined = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
    const [row] = await getExecutor(this.db)
      .insert(orgSettings)
      .values({ organizationId, ...defined })
      .onConflictDoUpdate({ target: orgSettings.organizationId, set: { ...defined, updatedAt: new Date() } })
      .returning();
    if (!row) throw new Error('org_settings upsert returned no row');
    return toRecord(row);
  }
}
