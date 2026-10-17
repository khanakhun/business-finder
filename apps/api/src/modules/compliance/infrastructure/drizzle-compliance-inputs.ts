import type { OutreachChannel } from '@bf/contracts';
import { type DbClient, getExecutor } from '@bf/db';
import {
  businessContacts,
  businesses,
  categories,
  lawfulBasisRecords,
  noSolicitationMarkers,
  offerRelevance,
  orgBusinesses,
} from '@bf/db/schema';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { DB_CLIENT } from '../../platform/db/db.module.ts';
import { WorkspaceReadiness } from '../../workspace/index.ts';
import {
  type ComplianceInputs,
  type DecisionContext,
  RECIPIENT_TYPE_RESOLVER,
  type RecipientTypeResolver,
} from '../application/ports.ts';
import { resolveJurisdictions } from '../domain/jurisdiction.ts';
import { emailDomain, normalizeKey } from '../domain/normalizers.ts';

// What a compliance decision is made from (BF-049), read for a business, its contact and the workspace: jurisdiction
// signals, the contact's kind and where it was published, verification, the no-solicitation marker, do-not-contact,
// the offer's relevance to the business's category, an approved lawful basis and the workspace's identity.
// DECISION(BF-049): the recipient type comes from a company registry where one is wired (FR, BL, MF), else `unknown`;
// `designatedForSolicitation` stays `unknown` until a person marks it — the seeded rules treat both conservatively.

const ADDRESS_TYPE: Record<string, 'generic' | 'department' | 'personal'> = {
  generic: 'generic',
  department: 'department',
  personal: 'personal',
};

@Injectable()
export class DrizzleComplianceInputs implements ComplianceInputs {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    private readonly readiness: WorkspaceReadiness,
    @Inject(RECIPIENT_TYPE_RESOLVER) private readonly recipients: RecipientTypeResolver,
  ) {}

  private get x() {
    return getExecutor(this.db);
  }

  async gather(input: {
    organizationId: string;
    businessId: string;
    contactId?: string | undefined;
    channel: OutreachChannel;
    purpose: string;
  }): Promise<DecisionContext> {
    const [business] = await this.x
      .select({
        name: businesses.displayName,
        countryCode: businesses.countryCode,
        postalCode: businesses.postalCode,
        phone: businesses.primaryPhoneE164,
        categoryPath: categories.path,
        doNotContact: orgBusinesses.doNotContact,
      })
      .from(businesses)
      .leftJoin(categories, eq(categories.id, businesses.primaryCategoryId))
      .leftJoin(
        orgBusinesses,
        and(
          eq(orgBusinesses.businessId, businesses.id),
          eq(orgBusinesses.organizationId, input.organizationId),
        ),
      )
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    const contact = input.contactId
      ? (
          await this.x
            .select()
            .from(businessContacts)
            .where(
              and(
                eq(businessContacts.id, input.contactId),
                eq(businessContacts.businessId, input.businessId),
              ),
            )
            .limit(1)
        )[0]
      : undefined;
    const [marker] = await this.x
      .select({ businessId: noSolicitationMarkers.businessId })
      .from(noSolicitationMarkers)
      .where(
        and(eq(noSolicitationMarkers.businessId, input.businessId), isNull(noSolicitationMarkers.clearedAt)),
      )
      .limit(1);
    const [basis] = await this.x
      .select({ id: lawfulBasisRecords.id })
      .from(lawfulBasisRecords)
      .where(
        and(
          eq(lawfulBasisRecords.organizationId, input.organizationId),
          eq(lawfulBasisRecords.status, 'approved'),
        ),
      )
      .orderBy(desc(lawfulBasisRecords.approvedAt))
      .limit(1);
    const relevanceRows = await this.x
      .select({ prefix: offerRelevance.taxonomyPrefix, relevant: offerRelevance.relevant })
      .from(offerRelevance)
      .where(eq(offerRelevance.offer, input.purpose))
      .orderBy(asc(offerRelevance.position));
    const path = business?.categoryPath ? String(business.categoryPath) : null;
    const match = path
      ? relevanceRows.find(
          (row) => row.prefix === '' || path === row.prefix || path.startsWith(`${row.prefix}.`),
        )
      : undefined;
    const readiness = await this.readiness.forOutreach(input.organizationId);

    const email = contact?.type === 'email' ? contact.normalizedValue : null;
    const contactPhone = contact?.type === 'phone' ? contact.normalizedValue : null;
    const phone = contactPhone ?? business?.phone ?? null;
    const published = contact?.publishedContext?.pageKind;
    const keys: DecisionContext['suppressionKeys'] = [];
    const key = (scope: DecisionContext['suppressionKeys'][number]['scope'], value: string | null) => {
      const normalized = value ? normalizeKey(scope, value) : null;
      if (normalized) keys.push({ scope, value: normalized });
    };
    key('org_business', input.businessId);
    key('business', input.businessId);
    key('email', email);
    key('domain', email ? emailDomain(email) : null);
    key('phone', phone);

    const jurisdictions = resolveJurisdictions({
      countryCode: business?.countryCode ?? null,
      postalCode: business?.postalCode ?? null,
      phone,
      email,
    });
    const recipientType = business
      ? await this.recipients.resolve({
          id: input.businessId,
          name: business.name,
          postalCode: business.postalCode,
          jurisdictions,
        })
      : 'unknown';
    return {
      jurisdictions,
      inputs: {
        recipientType,
        addressType:
          input.channel === 'email' ? (ADDRESS_TYPE[contact?.subtype ?? ''] ?? 'unknown') : 'unknown',
        publishedContext: published
          ? published === 'contact'
            ? 'own_contact_page'
            : 'own_site_other'
          : contact && contact.source !== 'website'
            ? 'directory'
            : 'unknown',
        designatedForSolicitation: 'unknown',
        relevance: match ? (match.relevant ? 'relevant' : 'not_relevant') : 'unknown',
        previousContact: 'none',
        suppressed: false,
        doNotContact: business?.doNotContact ?? false,
        noSolicitationMarker: marker !== undefined,
        addressInvalid:
          input.channel === 'email' &&
          (!email ||
            contact?.verificationStatus === 'invalid' ||
            contact?.verificationStatus === 'disposable'),
        workspaceReady: readiness.ready,
        lawfulBasisApproved: basis !== undefined,
      },
      suppressionKeys: keys,
      lawfulBasisId: basis?.id ?? null,
    };
  }
}
