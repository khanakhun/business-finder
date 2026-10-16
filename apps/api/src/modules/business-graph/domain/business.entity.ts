import {
  BusinessCreated,
  BusinessMerged,
  BusinessUpdated,
  type ContactType,
  type OperatingStatus,
  type PostalAddress as PostalAddressShape,
  type Provenance,
  type SourceProvider,
} from '@bf/contracts';
import { type BusinessContactProps, normalizeContact } from './business-contact.ts';
import { BusinessMergedError, InvalidValueError } from './errors.ts';
import type { BusinessName } from './value-objects/business-name.ts';
import type { GeoPoint } from './value-objects/geo-point.ts';
import type { PhoneNumber } from './value-objects/phone-number.ts';
import type { PostalAddress } from './value-objects/postal-address.ts';
import { type ProvenanceInput, provenanceOf } from './value-objects/provenance.ts';
import type { WebsiteUrl } from './value-objects/website-url.ts';

/** Fields whose value is chosen across sources and carries provenance in `attributes`. */
export type GoldenField =
  | 'displayName'
  | 'operatingStatus'
  | 'websiteUrl'
  | 'primaryPhone'
  | 'address'
  | 'location'
  | 'priceLevel'
  | 'rating';

export interface BusinessState {
  readonly id: string;
  readonly displayName: string;
  readonly normalizedName: string;
  readonly primaryCategoryId: string | null;
  readonly operatingStatus: OperatingStatus;
  readonly websiteUrl: string | null;
  readonly websiteHost: string | null;
  readonly websiteRegistrableDomain: string | null;
  readonly primaryPhoneE164: string | null;
  readonly countryCode: string | null;
  readonly localeHint: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly address: Partial<PostalAddressShape> | null;
  readonly formattedAddress: string | null;
  readonly locality: string | null;
  readonly postalCode: string | null;
  readonly priceLevel: number | null;
  readonly ratingAvg: number | null;
  readonly ratingCount: number | null;
  readonly attributes: Readonly<Record<string, Provenance>>;
  readonly dataQuality: number | null;
  readonly mergedIntoId: string | null;
  readonly version: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
}

/** A value proposed for a golden field, typed per field. */
export type FieldValue =
  | { readonly field: 'displayName'; readonly value: BusinessName }
  | { readonly field: 'operatingStatus'; readonly value: OperatingStatus }
  | { readonly field: 'websiteUrl'; readonly value: WebsiteUrl | null }
  | { readonly field: 'primaryPhone'; readonly value: PhoneNumber | null }
  | { readonly field: 'address'; readonly value: PostalAddress | null }
  | { readonly field: 'location'; readonly value: GeoPoint | null }
  | { readonly field: 'priceLevel'; readonly value: number | null }
  | { readonly field: 'rating'; readonly value: { readonly avg: number; readonly count: number } | null };

/**
 * Decides whether a proposed value replaces the current one (Strategy). Full source-priority rules come with entity
 * resolution (BF-016); the default prefers manual edits, then higher confidence, then newer observations.
 */
export type Survivorship = (current: Provenance | undefined, incoming: Provenance) => boolean;

export const defaultSurvivorship: Survivorship = (current, incoming) => {
  if (!current) return true;
  if (incoming.source === 'manual' && current.source !== 'manual') return true;
  if (current.source === 'manual' && incoming.source !== 'manual') return false;
  if (incoming.confidence !== current.confidence) return incoming.confidence > current.confidence;
  return incoming.observedAt >= current.observedAt;
};

/** Domain events awaiting the outbox, typed per definition. */
export type PendingEvent =
  | {
      readonly type: 'business.created';
      readonly definition: typeof BusinessCreated;
      readonly payload: { businessId: string; source: SourceProvider };
    }
  | {
      readonly type: 'business.updated';
      readonly definition: typeof BusinessUpdated;
      readonly payload: { businessId: string; fields: string[] };
    }
  | {
      readonly type: 'business.merged';
      readonly definition: typeof BusinessMerged;
      readonly payload: { businessId: string; intoId: string };
    };

export interface NewBusinessInput {
  readonly id: string;
  readonly name: BusinessName;
  readonly countryCode: string | null;
  readonly localeHint?: string | null;
  readonly website?: WebsiteUrl | null;
  readonly phone?: PhoneNumber | null;
  readonly address?: PostalAddress | null;
  readonly location?: GeoPoint | null;
  readonly operatingStatus?: OperatingStatus;
  readonly provenance: ProvenanceInput;
}

/**
 * Business golden record (DOMAIN.md §2): global facts with per-field provenance. Invariants: every non-null golden
 * field has provenance; coordinates are valid; a merged record is read-only.
 */
export class Business {
  private state: BusinessState;
  private readonly pending: PendingEvent[] = [];
  private readonly newContacts: BusinessContactProps[] = [];
  /** Never saved: the repository inserts it. */
  private unsaved: boolean;
  /** The `businesses` row differs from what was loaded (contacts alone do not count). */
  private rowDirty: boolean;

  private constructor(state: BusinessState, isNew: boolean) {
    this.state = state;
    this.unsaved = isNew;
    this.rowDirty = isNew;
  }

  static create(input: NewBusinessInput): Business {
    const observedAt = input.provenance.observedAt;
    const business = new Business(
      {
        id: input.id,
        displayName: input.name.display,
        normalizedName: input.name.normalized,
        primaryCategoryId: null,
        operatingStatus: 'unknown',
        websiteUrl: null,
        websiteHost: null,
        websiteRegistrableDomain: null,
        primaryPhoneE164: null,
        countryCode: input.countryCode?.toUpperCase() ?? null,
        localeHint: input.localeHint ?? null,
        location: null,
        address: null,
        formattedAddress: null,
        locality: null,
        postalCode: null,
        priceLevel: null,
        ratingAvg: null,
        ratingCount: null,
        attributes: { displayName: provenanceOf(input.name.display, input.provenance) },
        dataQuality: null,
        mergedIntoId: null,
        version: 0,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
      },
      true,
    );
    const initial: FieldValue[] = [
      ...(input.operatingStatus ? [{ field: 'operatingStatus', value: input.operatingStatus } as const] : []),
      ...(input.website ? [{ field: 'websiteUrl', value: input.website } as const] : []),
      ...(input.phone ? [{ field: 'primaryPhone', value: input.phone } as const] : []),
      ...(input.address ? [{ field: 'address', value: input.address } as const] : []),
      ...(input.location ? [{ field: 'location', value: input.location } as const] : []),
    ];
    for (const value of initial) business.apply(value, provenanceOf(null, input.provenance));
    business.pending.push({
      type: 'business.created',
      definition: BusinessCreated,
      payload: { businessId: input.id, source: input.provenance.source },
    });
    return business;
  }

  static rehydrate(state: BusinessState): Business {
    Business.assertProvenance(state);
    return new Business(state, false);
  }

  get id(): string {
    return this.state.id;
  }

  get version(): number {
    return this.state.version;
  }

  get isNew(): boolean {
    return this.unsaved;
  }

  /** Whether saving must write the `businesses` row (and bump `version`); adding contacts alone does not. */
  get hasRowChanges(): boolean {
    return this.rowDirty;
  }

  get isMerged(): boolean {
    return this.state.mergedIntoId !== null;
  }

  /** A copy of the current state (for repositories and read models). */
  snapshot(): BusinessState {
    return { ...this.state, attributes: { ...this.state.attributes } };
  }

  /**
   * Proposes a value for a golden field from a source. Applied when `survivorship` prefers it; returns whether the
   * field changed. Records `business.updated` with the changed fields.
   */
  updateField(
    value: FieldValue,
    provenance: ProvenanceInput,
    survivorship: Survivorship = defaultSurvivorship,
  ): boolean {
    this.assertWritable();
    const incoming = provenanceOf(null, provenance);
    const key = value.field;
    // A source re-confirming the business counts as a sighting even when its value loses.
    this.touch(provenance.observedAt);
    if (!survivorship(this.state.attributes[key], incoming)) return false;
    const changed = this.apply(value, incoming);
    this.rowDirty = true;
    if (changed) {
      this.pending.push({
        type: 'business.updated',
        definition: BusinessUpdated,
        payload: { businessId: this.state.id, fields: [key] },
      });
    }
    return changed;
  }

  /** `null` when no source classifies the business any more. */
  setPrimaryCategory(categoryId: string | null): void {
    this.assertWritable();
    if (this.state.primaryCategoryId === categoryId) return;
    this.state = { ...this.state, primaryCategoryId: categoryId };
    this.rowDirty = true;
    this.pending.push({
      type: 'business.updated',
      definition: BusinessUpdated,
      payload: { businessId: this.state.id, fields: ['primaryCategoryId'] },
    });
  }

  /**
   * Records `business.updated` for data stored beside the aggregate (hours, categories, contacts removed by a
   * recompute), so subscribers hear about every change in one event per save.
   */
  noteChanged(fields: readonly string[]): void {
    this.assertWritable();
    if (fields.length === 0) return;
    this.pending.push({
      type: 'business.updated',
      definition: BusinessUpdated,
      payload: { businessId: this.state.id, fields: [...fields] },
    });
  }

  /** A contact for this business (saved with the aggregate); invalid values throw. */
  addContact(input: {
    readonly id: string;
    readonly type: ContactType;
    readonly value: string;
    readonly personName?: string | null;
    readonly source: SourceProvider;
    readonly sourceUrl?: string | null;
    readonly publishedOnSite?: boolean;
    readonly confidence: number;
    readonly submittedByOrgId?: string | null;
  }): BusinessContactProps {
    this.assertWritable();
    if (!(input.confidence >= 0 && input.confidence <= 1)) {
      throw new InvalidValueError('contact', 'Confidence must be between 0 and 1.');
    }
    const normalized = normalizeContact(input.type, input.value, this.state.countryCode);
    const contact: BusinessContactProps = {
      id: input.id,
      businessId: this.state.id,
      type: input.type,
      value: input.value.trim(),
      ...normalized,
      personName: input.personName?.trim() || null,
      source: input.source,
      sourceUrl: input.sourceUrl ?? null,
      publishedOnSite: input.publishedOnSite ?? false,
      confidence: input.confidence,
      submittedByOrgId: input.submittedByOrgId ?? null,
    };
    this.newContacts.push(contact);
    this.pending.push({
      type: 'business.updated',
      definition: BusinessUpdated,
      payload: { businessId: this.state.id, fields: ['contacts'] },
    });
    return contact;
  }

  /** Entity resolution found this record duplicates `intoId`; it becomes read-only. */
  markMerged(intoId: string): void {
    this.assertWritable();
    if (intoId === this.state.id)
      throw new InvalidValueError('merge', 'A business cannot be merged into itself.');
    this.state = { ...this.state, mergedIntoId: intoId };
    this.rowDirty = true;
    this.pending.push({
      type: 'business.merged',
      definition: BusinessMerged,
      payload: { businessId: this.state.id, intoId },
    });
  }

  /**
   * Events since the last pull (for the outbox): one `business.updated` with every changed field, or none when the
   * record was created in the same unit of work.
   */
  pullEvents(): PendingEvent[] {
    const events = this.pending.splice(0);
    const fields = [
      ...new Set(events.flatMap((e) => (e.type === 'business.updated' ? e.payload.fields : []))),
    ];
    const others = events.filter((e) => e.type !== 'business.updated');
    // A record created in this unit of work is announced once: its initial values are part of `business.created`.
    if (fields.length === 0 || others.some((e) => e.type === 'business.created')) return others;
    return [
      ...others,
      {
        type: 'business.updated',
        definition: BusinessUpdated,
        payload: { businessId: this.state.id, fields },
      },
    ];
  }

  pullNewContacts(): BusinessContactProps[] {
    return this.newContacts.splice(0);
  }

  /** Called by the repository after a successful save. */
  markSaved(version: number): void {
    this.state = { ...this.state, version };
    this.unsaved = false;
    this.rowDirty = false;
  }

  private assertWritable(): void {
    if (this.state.mergedIntoId) throw new BusinessMergedError(this.state.id, this.state.mergedIntoId);
  }

  private touch(at: Date): void {
    if (at > this.state.lastSeenAt) {
      this.state = { ...this.state, lastSeenAt: at };
      this.rowDirty = true;
    }
  }

  /** Writes the value and its provenance; returns whether the stored value changed. */
  private apply(value: FieldValue, provenance: Provenance): boolean {
    const before = JSON.stringify(this.goldenValue(value.field));
    const next = { ...this.state };
    switch (value.field) {
      case 'displayName':
        Object.assign(next, { displayName: value.value.display, normalizedName: value.value.normalized });
        break;
      case 'operatingStatus':
        Object.assign(next, { operatingStatus: value.value });
        break;
      case 'websiteUrl':
        Object.assign(next, {
          websiteUrl: value.value?.canonical ?? null,
          websiteHost: value.value?.host ?? null,
          websiteRegistrableDomain:
            value.value && !value.value.isSharedHost ? value.value.registrableDomain : null,
        });
        break;
      case 'primaryPhone':
        Object.assign(next, { primaryPhoneE164: value.value?.e164 ?? null });
        break;
      case 'address':
        Object.assign(next, {
          address: value.value?.components ?? null,
          formattedAddress: value.value?.formatted ?? null,
          locality: value.value?.components.city ?? null,
          postalCode: value.value?.components.postalCode ?? null,
          countryCode: value.value?.components.countryCode ?? this.state.countryCode,
        });
        break;
      case 'location':
        Object.assign(next, { location: value.value?.toJSON() ?? null });
        break;
      case 'priceLevel':
        if (
          value.value !== null &&
          !(Number.isInteger(value.value) && value.value >= 0 && value.value <= 4)
        ) {
          throw new InvalidValueError('priceLevel', 'Price level is 0–4.');
        }
        Object.assign(next, { priceLevel: value.value });
        break;
      case 'rating': {
        const rating = value.value;
        if (
          rating &&
          !(rating.avg >= 0 && rating.avg <= 5 && Number.isInteger(rating.count) && rating.count >= 0)
        ) {
          throw new InvalidValueError('rating', 'Ratings are 0–5 with a whole, non-negative count.');
        }
        // Stored as numeric(2,1): round here so the provenance value matches the column.
        const avg = rating ? Math.round(rating.avg * 10) / 10 : null;
        Object.assign(next, { ratingAvg: avg, ratingCount: rating?.count ?? null });
        break;
      }
    }
    this.state = next;
    const after = this.goldenValue(value.field);
    const attributes = { ...this.state.attributes };
    if (after === null) delete attributes[value.field];
    else attributes[value.field] = { ...provenance, value: after };
    this.state = { ...this.state, attributes };
    return JSON.stringify(after) !== before;
  }

  private goldenValue(field: GoldenField): unknown {
    const s = this.state;
    switch (field) {
      case 'displayName':
        return s.displayName;
      case 'operatingStatus':
        return s.operatingStatus === 'unknown' ? null : s.operatingStatus;
      case 'websiteUrl':
        return s.websiteUrl;
      case 'primaryPhone':
        return s.primaryPhoneE164;
      case 'address':
        return s.address;
      case 'location':
        return s.location;
      case 'priceLevel':
        return s.priceLevel;
      case 'rating':
        return s.ratingAvg === null ? null : { avg: s.ratingAvg, count: s.ratingCount };
    }
  }

  private static assertProvenance(state: BusinessState): void {
    const golden: Array<[GoldenField, unknown]> = [
      ['displayName', state.displayName],
      ['websiteUrl', state.websiteUrl],
      ['primaryPhone', state.primaryPhoneE164],
      ['address', state.address],
      ['location', state.location],
      ['priceLevel', state.priceLevel],
      ['rating', state.ratingAvg],
    ];
    const missing = golden
      .filter(([field, value]) => value !== null && !state.attributes[field])
      .map(([f]) => f);
    if (missing.length > 0) {
      throw new InvalidValueError(
        'provenance',
        `Business ${state.id} has values without provenance: ${missing.join(', ')}`,
      );
    }
  }
}
