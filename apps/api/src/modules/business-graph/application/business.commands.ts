import {
  type AddContactRequest,
  type Clock,
  type Contact,
  type CreateManualBusinessRequest,
  NotFoundError,
  newId,
  type OrgBusinessState,
  type TrackBusinessRequest,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { AuditLogger } from '../../workspace/index.ts';
import { Business } from '../domain/business.entity.ts';
import { BusinessMergedError } from '../domain/errors.ts';
import { BusinessName } from '../domain/value-objects/business-name.ts';
import { GeoPoint } from '../domain/value-objects/geo-point.ts';
import { PhoneNumber } from '../domain/value-objects/phone-number.ts';
import { PostalAddress } from '../domain/value-objects/postal-address.ts';
import type { ProvenanceInput } from '../domain/value-objects/provenance.ts';
import { WebsiteUrl } from '../domain/value-objects/website-url.ts';
import { contentHash } from './content-hash.ts';
import { toContact, toOrgBusinessState } from './mappers.ts';
import {
  BUSINESS_REPOSITORY,
  type BusinessRepository,
  CONTACT_REPOSITORY,
  type ContactRepository,
  ORG_BUSINESS_REPOSITORY,
  type OrgBusinessRepository,
  SOURCE_RECORD_REPOSITORY,
  type SourceRecordRepository,
} from './ports.ts';
import { workspaceOf } from './workspace-of.ts';

/** Records the aggregate's pending events in the outbox (inside the caller's transaction). */
async function recordEvents(recorder: EventRecorder, business: Business): Promise<void> {
  for (const event of business.pullEvents()) {
    switch (event.type) {
      case 'business.created':
        await recorder.record(event.definition, { payload: event.payload });
        break;
      case 'business.updated':
        await recorder.record(event.definition, { payload: event.payload });
        break;
      case 'business.merged':
        await recorder.record(event.definition, { payload: event.payload });
        break;
    }
  }
}

/** Adds a business to the workspace (idempotent: tracking it again returns the existing state). */
@Injectable()
export class TrackBusinessCommand {
  constructor(
    @Inject(BUSINESS_REPOSITORY) private readonly businesses: BusinessRepository,
    @Inject(ORG_BUSINESS_REPOSITORY) private readonly orgBusinesses: OrgBusinessRepository,
    private readonly audit: AuditLogger,
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
 * A business the workspace adds by hand: a `manual` source record, a golden record and the workspace's link, in one
 * transaction. Workspace input to global facts is audited with the workspace (ADR-0008).
 */
@Injectable()
export class CreateManualBusinessCommand {
  constructor(
    @Inject(BUSINESS_REPOSITORY) private readonly businesses: BusinessRepository,
    @Inject(SOURCE_RECORD_REPOSITORY) private readonly sources: SourceRecordRepository,
    @Inject(ORG_BUSINESS_REPOSITORY) private readonly orgBusinesses: OrgBusinessRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventRecorder,
    private readonly audit: AuditLogger,
  ) {}

  /** Returns the new business id. */
  @Transactional()
  async execute(auth: AuthContext, request: CreateManualBusinessRequest): Promise<string> {
    const organizationId = workspaceOf(auth);
    const now = this.clock.now();
    const businessId = newId();
    const sourceId = newId();
    const provenance: ProvenanceInput = {
      source: 'manual',
      sourceRef: sourceId,
      confidence: 1,
      observedAt: now,
    };
    const hasAddress = Boolean(request.formattedAddress || request.locality || request.postalCode);
    // TODO(BF-016): route through ingestion (normalize → match → merge) so a manual add can join an existing record.
    const business = Business.create({
      id: businessId,
      name: BusinessName.parse(request.displayName),
      countryCode: request.countryCode,
      website: request.websiteUrl ? WebsiteUrl.parse(request.websiteUrl) : null,
      phone: request.phone ? PhoneNumber.parse(request.phone, request.countryCode) : null,
      address: hasAddress
        ? PostalAddress.of(
            {
              ...(request.locality ? { city: request.locality } : {}),
              ...(request.postalCode ? { postalCode: request.postalCode } : {}),
              countryCode: request.countryCode,
            },
            request.formattedAddress,
          )
        : null,
      location: request.location ? GeoPoint.of(request.location.lat, request.location.lng) : null,
      operatingStatus: 'operational',
      provenance,
    });
    if (request.phone) {
      business.addContact({
        id: newId(),
        type: 'phone',
        value: request.phone,
        source: 'manual',
        confidence: 1,
        submittedByOrgId: organizationId,
      });
    }
    if (request.email) {
      business.addContact({
        id: newId(),
        type: 'email',
        value: request.email,
        source: 'manual',
        confidence: 1,
        submittedByOrgId: organizationId,
      });
    }
    await this.businesses.save(business);
    await this.sources.upsert({
      id: sourceId,
      businessId,
      provider: 'manual',
      providerRef: sourceId,
      payload: request,
      normalized: null,
      contentHash: contentHash(request),
      fetchedAt: now,
      expiresAt: null,
      matchConfidence: 1,
      linkedBy: 'manual',
      submittedByOrgId: organizationId,
    });
    await this.orgBusinesses.track({ organizationId, businessId, addedVia: 'manual', addedRef: null });
    await recordEvents(this.events, business);
    await this.audit.record({ action: 'business.created', entityType: 'business', entityId: businessId });
    return businessId;
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
    if (existing) return toContact(existing);
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
    return toContact(saved);
  }
}
