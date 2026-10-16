import {
  type AddContactRequest,
  type Clock,
  type Contact,
  type CreateManualBusinessRequest,
  NotFoundError,
  newId,
  type OrgBusinessState,
  OrgBusinessTracked,
  type TrackBusinessRequest,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { AuditLogger } from '../../workspace/index.ts';
import { BusinessMergedError } from '../domain/errors.ts';
import { BusinessName } from '../domain/value-objects/business-name.ts';
import { EmailAddress } from '../domain/value-objects/email-address.ts';
import { GeoPoint } from '../domain/value-objects/geo-point.ts';
import { PhoneNumber } from '../domain/value-objects/phone-number.ts';
import { WebsiteUrl } from '../domain/value-objects/website-url.ts';
import { toContact, toOrgBusinessState } from './mappers.ts';
import {
  BUSINESS_REPOSITORY,
  type BusinessRepository,
  CONTACT_REPOSITORY,
  type ContactRepository,
  ORG_BUSINESS_REPOSITORY,
  type OrgBusinessRepository,
} from './ports.ts';
import { recordEvents } from './record-events.ts';
import { IngestSourceRecordCommand } from './resolution/ingest-source-record.command.ts';
import { workspaceOf } from './workspace-of.ts';

/** Adds a business to the workspace (idempotent: tracking it again returns the existing state). */
@Injectable()
export class TrackBusinessCommand {
  constructor(
    @Inject(BUSINESS_REPOSITORY) private readonly businesses: BusinessRepository,
    @Inject(ORG_BUSINESS_REPOSITORY) private readonly orgBusinesses: OrgBusinessRepository,
    private readonly audit: AuditLogger,
    private readonly events: EventRecorder,
  ) {}

  @Transactional()
  async execute(
    auth: AuthContext,
    businessId: string,
    request: TrackBusinessRequest,
  ): Promise<{ readonly state: OrgBusinessState; readonly created: boolean }> {
    const business = await this.businesses.getById(businessId);
    if (!business) throw new NotFoundError('Business', businessId);
    const { mergedIntoId } = business.snapshot();
    if (mergedIntoId) throw new BusinessMergedError(businessId, mergedIntoId);
    const { record, created } = await this.orgBusinesses.track({
      organizationId: workspaceOf(auth),
      businessId,
      addedVia: request.addedVia,
      addedRef: request.addedRef ?? null,
    });
    if (created) {
      await this.events.record(OrgBusinessTracked, {
        orgId: record.organizationId,
        payload: { businessId, addedVia: request.addedVia },
      });
      await this.audit.record({
        action: 'business.tracked',
        entityType: 'business',
        entityId: businessId,
        metadata: { addedVia: request.addedVia },
      });
    }
    return { state: toOrgBusinessState(record), created };
  }
}

/**
 * A business the workspace adds by hand: a `manual` source record goes through ingestion (BF-016), so it joins an
 * existing golden record when it describes one, and the workspace tracks the result. Workspace input to global
 * facts is attributed and audited (ADR-0008).
 */
@Injectable()
export class CreateManualBusinessCommand {
  constructor(
    @Inject(ORG_BUSINESS_REPOSITORY) private readonly orgBusinesses: OrgBusinessRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ingest: IngestSourceRecordCommand,
    private readonly audit: AuditLogger,
    private readonly events: EventRecorder,
  ) {}

  /** Returns the id of the business now tracked (new, or the existing one it matched). */
  @Transactional()
  async execute(auth: AuthContext, request: CreateManualBusinessRequest): Promise<string> {
    const organizationId = workspaceOf(auth);
    // Ingestion drops invalid values; someone typing them deserves a 422 instead.
    BusinessName.parse(request.displayName);
    if (request.websiteUrl) WebsiteUrl.parse(request.websiteUrl);
    if (request.phone) PhoneNumber.parse(request.phone, request.countryCode);
    if (request.email) EmailAddress.parse(request.email);
    if (request.location) GeoPoint.of(request.location.lat, request.location.lng);
    const sourceId = newId();
    const result = await this.ingest.execute(
      {
        provider: 'manual',
        providerRef: sourceId,
        fetchedAt: this.clock.now().toISOString(),
        name: request.displayName,
        ...(request.location ? { location: request.location } : {}),
        address: {
          countryCode: request.countryCode,
          ...(request.formattedAddress ? { formatted: request.formattedAddress } : {}),
          ...(request.locality ? { city: request.locality } : {}),
          ...(request.postalCode ? { postalCode: request.postalCode } : {}),
        },
        phones: request.phone ? [request.phone] : [],
        ...(request.websiteUrl ? { website: request.websiteUrl } : {}),
        emails: request.email ? [request.email] : [],
        operatingStatus: 'operational',
      },
      { orgId: organizationId, sourceId, defaultRegion: request.countryCode, classifyWithModel: false },
    );
    const { created } = await this.orgBusinesses.track({
      organizationId,
      businessId: result.businessId,
      addedVia: 'manual',
      addedRef: null,
    });
    if (created) {
      await this.events.record(OrgBusinessTracked, {
        orgId: organizationId,
        payload: { businessId: result.businessId, addedVia: 'manual' },
      });
    }
    await this.audit.record({
      action: 'business.created',
      entityType: 'business',
      entityId: result.businessId,
      metadata: { outcome: result.outcome },
    });
    return result.businessId;
  }
}

/** A contact the workspace adds by hand (provenance `manual`); adding a known contact returns it. */
@Injectable()
export class AddContactCommand {
  constructor(
    @Inject(BUSINESS_REPOSITORY) private readonly businesses: BusinessRepository,
    @Inject(ORG_BUSINESS_REPOSITORY) private readonly orgBusinesses: OrgBusinessRepository,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
    private readonly events: EventRecorder,
    private readonly audit: AuditLogger,
  ) {}

  @Transactional()
  async execute(auth: AuthContext, businessId: string, request: AddContactRequest): Promise<Contact> {
    const organizationId = workspaceOf(auth);
    const tracked = await this.orgBusinesses.find(organizationId, businessId);
    const business = tracked ? await this.businesses.getById(businessId) : undefined;
    if (!business) throw new NotFoundError('Business', businessId);
    const added = business.addContact({
      id: newId(),
      type: request.type,
      value: request.value,
      source: 'manual',
      confidence: 1,
      submittedByOrgId: organizationId,
    });
    const existing = await this.contacts.find(businessId, added.type, added.normalizedValue);
    if (existing) return toContact(existing, business.snapshot().websiteHost);
    await this.businesses.save(business);
    await recordEvents(this.events, business);
    await this.audit.record({
      action: 'business.contact_added',
      entityType: 'business',
      entityId: businessId,
      metadata: { contactId: added.id, type: added.type },
    });
    const saved = await this.contacts.find(businessId, added.type, added.normalizedValue);
    if (!saved) throw new Error(`Contact ${added.id} missing after save`);
    return toContact(saved, business.snapshot().websiteHost);
  }
}
