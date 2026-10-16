import type { BusinessDetail, BusinessSummary } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import { businessCategories, businesses, businessHours, businessMedia, orgBusinesses } from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import { toContact, toOrgBusinessState } from '../application/mappers.ts';
import type { BusinessReadModel } from '../application/ports.ts';
import { DrizzleContactRepository } from './drizzle-contact.repository.ts';

type BusinessRow = typeof businesses.$inferSelect;
type OrgBusinessRow = typeof orgBusinesses.$inferSelect;

const toSummary = (b: BusinessRow, ob: OrgBusinessRow): BusinessSummary => ({
  id: b.id as BusinessSummary['id'],
  displayName: b.displayName,
  primaryCategoryId: b.primaryCategoryId,
  operatingStatus: b.operatingStatus,
  websiteUrl: b.websiteUrl,
  primaryPhone: b.primaryPhoneE164,
  locality: b.locality,
  countryCode: b.countryCode,
  location: b.location,
  ratingAvg: b.ratingAvg,
  ratingCount: b.ratingCount,
  pipelineStatus: ob.pipelineStatus,
});

/** `HH:MM:SS` → `HH:MM`. */
const hhmm = (time: string) => time.slice(0, 5);

@Injectable()
export class DrizzleBusinessReadModel implements BusinessReadModel {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    private readonly contacts: DrizzleContactRepository,
  ) {}

  async detail(organizationId: string, businessId: string): Promise<BusinessDetail | undefined> {
    const executor = getExecutor(this.db);
    const [head] = await executor
      .select({ business: businesses, org: orgBusinesses })
      .from(orgBusinesses)
      .innerJoin(businesses, eq(businesses.id, orgBusinesses.businessId))
      .where(and(eq(orgBusinesses.organizationId, organizationId), eq(orgBusinesses.businessId, businessId)));
    if (!head) return undefined;
    const [contacts, categories, hours, media] = await Promise.all([
      this.contacts.listByBusiness(businessId),
      executor
        .select({
          categoryId: businessCategories.categoryId,
          isPrimary: businessCategories.isPrimary,
          confidence: businessCategories.confidence,
        })
        .from(businessCategories)
        .where(eq(businessCategories.businessId, businessId))
        .orderBy(desc(businessCategories.isPrimary), desc(businessCategories.confidence)),
      executor
        .select({
          weekday: businessHours.weekday,
          opensAt: businessHours.opensAt,
          closesAt: businessHours.closesAt,
        })
        .from(businessHours)
        .where(eq(businessHours.businessId, businessId))
        .orderBy(asc(businessHours.weekday), asc(businessHours.opensAt)),
      executor
        .select({
          id: businessMedia.id,
          kind: businessMedia.kind,
          license: businessMedia.license,
          externalUrl: businessMedia.externalUrl,
        })
        .from(businessMedia)
        .where(eq(businessMedia.businessId, businessId))
        .orderBy(asc(businessMedia.createdAt), asc(businessMedia.id))
        .limit(50),
    ]);
    const b = head.business;
    return {
      ...toSummary(b, head.org),
      formattedAddress: b.formattedAddress,
      address: b.address,
      postalCode: b.postalCode,
      priceLevel: b.priceLevel,
      attributes: b.attributes,
      dataQuality: b.dataQuality,
      categories,
      hours: hours.map((h) => ({ weekday: h.weekday, opensAt: hhmm(h.opensAt), closesAt: hhmm(h.closesAt) })),
      // Stored objects get signed URLs once media storage lands (BF-026+); external URLs are provider links.
      media: media.map((m) => ({ id: m.id, kind: m.kind, license: m.license, url: m.externalUrl })),
      contacts: contacts.map((contact) => toContact(contact, b.websiteHost)),
      orgState: toOrgBusinessState(head.org),
      firstSeenAt: b.firstSeenAt.toISOString(),
      lastSeenAt: b.lastSeenAt.toISOString(),
      version: b.version,
    };
  }
}
