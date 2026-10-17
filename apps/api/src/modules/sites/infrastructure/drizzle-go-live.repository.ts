import type { SiteLegalProfile } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { siteContactRouting, siteLegalProfiles } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import type { ContactRoutingRecord, GoLiveContext, GoLiveRepository } from '../application/go-live/ports.ts';

/** Legal profiles, contact routing and the readiness context (BF-062). */
@Injectable()
export class DrizzleGoLiveRepository implements GoLiveRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async context(
    organizationId: string,
    siteId: string,
    versionId: string,
  ): Promise<GoLiveContext | undefined> {
    const [row] = await getExecutor(this.db).execute<{
      business_id: string;
      business_name: string;
      pipeline_status: string | null;
      country_code: string | null;
      quality: string | null;
    }>(sql`
      SELECT s.business_id::text, b.display_name AS business_name, ob.pipeline_status, b.country_code,
        (SELECT j.status FROM generation_jobs j
          WHERE j.organization_id = s.organization_id AND j.result_version_id = ${versionId}::uuid
          ORDER BY j.updated_at DESC LIMIT 1) AS quality
      FROM sites s
      JOIN businesses b ON b.id = s.business_id
      LEFT JOIN org_businesses ob ON ob.organization_id = s.organization_id AND ob.business_id = s.business_id
      WHERE s.id = ${siteId}::uuid AND s.organization_id = ${organizationId}::uuid`);
    if (!row) return undefined;
    const quality =
      row.quality === 'succeeded' || row.quality === 'needs_review' || row.quality === 'failed'
        ? row.quality
        : null;
    return {
      businessId: row.business_id,
      businessName: row.business_name,
      pipelineStatus: row.pipeline_status,
      countryCode: row.country_code,
      quality,
    };
  }

  async legal(organizationId: string, siteId: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(siteLegalProfiles)
      .where(and(eq(siteLegalProfiles.organizationId, organizationId), eq(siteLegalProfiles.siteId, siteId)));
    return row ? legalView(row) : undefined;
  }

  async saveLegal(
    organizationId: string,
    siteId: string,
    profile: Omit<SiteLegalProfile, 'version' | 'updatedAt'>,
    userId: string | null,
  ) {
    const values = {
      businessLegalName: profile.businessLegalName,
      legalForm: profile.legalForm,
      registration: profile.registration,
      vatNumber: profile.vatNumber,
      address: profile.address,
      phone: profile.phone,
      email: profile.email,
      publicationDirector: profile.publicationDirector,
      dpoContact: profile.dpoContact,
      privacyAcknowledgedAt: profile.privacyAcknowledgedAt ? new Date(profile.privacyAcknowledgedAt) : null,
      contentConfirmedBy: profile.contentConfirmedBy,
      contentConfirmedAt: profile.contentConfirmedAt ? new Date(profile.contentConfirmedAt) : null,
      updatedBy: userId,
    };
    const [row] = await getExecutor(this.db)
      .insert(siteLegalProfiles)
      .values({ siteId, organizationId, ...values })
      .onConflictDoUpdate({
        target: siteLegalProfiles.siteId,
        set: { ...values, version: sql`${siteLegalProfiles.version} + 1`, updatedAt: sql`now()` },
      })
      .returning();
    if (!row) throw new Error('legal profile not stored');
    return legalView(row);
  }

  async routing(organizationId: string, siteId: string) {
    const [row] = await getExecutor(this.db)
      .select()
      .from(siteContactRouting)
      .where(
        and(eq(siteContactRouting.organizationId, organizationId), eq(siteContactRouting.siteId, siteId)),
      );
    return row as ContactRoutingRecord | undefined;
  }

  async setPending(
    organizationId: string,
    siteId: string,
    pending: { email: string; cc: string | null; tokenHash: string; expiresAt: Date },
  ) {
    const values = {
      pendingEmail: pending.email,
      pendingCc: pending.cc,
      tokenHash: pending.tokenHash,
      tokenExpiresAt: pending.expiresAt,
    };
    await getExecutor(this.db)
      .insert(siteContactRouting)
      .values({ siteId, organizationId, ...values })
      .onConflictDoUpdate({ target: siteContactRouting.siteId, set: { ...values, updatedAt: sql`now()` } });
  }

  async confirm(tokenHash: string, now: Date) {
    const [row] = await getExecutor(this.db)
      .update(siteContactRouting)
      .set({
        recipientEmail: sql`${siteContactRouting.pendingEmail}`,
        cc: sql`${siteContactRouting.pendingCc}`,
        verifiedAt: now,
        pendingEmail: null,
        pendingCc: null,
        tokenHash: null,
        tokenExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(siteContactRouting.tokenHash, tokenHash),
          gt(siteContactRouting.tokenExpiresAt, now),
          sql`${siteContactRouting.pendingEmail} IS NOT NULL`,
        ),
      )
      .returning();
    return row as ContactRoutingRecord | undefined;
  }
}

const legalView = (row: typeof siteLegalProfiles.$inferSelect): SiteLegalProfile => ({
  businessLegalName: row.businessLegalName,
  legalForm: row.legalForm,
  registration: row.registration,
  vatNumber: row.vatNumber,
  address: row.address,
  phone: row.phone,
  email: row.email,
  publicationDirector: row.publicationDirector,
  dpoContact: row.dpoContact,
  privacyAcknowledgedAt: row.privacyAcknowledgedAt?.toISOString() ?? null,
  contentConfirmedBy: row.contentConfirmedBy,
  contentConfirmedAt: row.contentConfirmedAt?.toISOString() ?? null,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});
