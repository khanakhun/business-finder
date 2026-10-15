import { newId, type PublishedContext } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { EventRecorder } from '../../../platform/events/event-recorder.ts';
import { Business } from '../../domain/business.entity.ts';
import { normalizeContact } from '../../domain/business-contact.ts';
import type { NormalizedSource } from '../../domain/resolution/normalized-source.ts';
import { computeGolden } from '../../domain/resolution/survivorship.ts';
import { BusinessName } from '../../domain/value-objects/business-name.ts';
import {
  BUSINESS_REPOSITORY,
  type BusinessRepository,
  CONTACT_REPOSITORY,
  type ContactRepository,
} from '../ports.ts';
import { recordEvents } from '../record-events.ts';
import { TaxonomyCache } from '../taxonomy/taxonomy-cache.ts';
import { RESOLUTION_REPOSITORY, type ResolutionRepository } from './ports.ts';

const samePublication = (a: PublishedContext | null, b: PublishedContext) =>
  a !== null && a.pageUrl === b.pageUrl && a.pageKind === b.pageKind && a.foundAs === b.foundAs;

/** Accepts every proposed value: the winner was already chosen by `computeGolden`. */
const ALWAYS = () => true;

/**
 * Writes a business's golden record from the full set of its sources (BF-016, survivorship stage): golden fields
 * on the aggregate, contacts (added, and derived ones no source backs any more removed), categories and hours —
 * then records the resulting events. Runs inside the caller's transaction.
 */
@Injectable()
export class GoldenRecordWriter {
  constructor(
    @Inject(BUSINESS_REPOSITORY) private readonly businesses: BusinessRepository,
    @Inject(CONTACT_REPOSITORY) private readonly contacts: ContactRepository,
    @Inject(RESOLUTION_REPOSITORY) private readonly resolution: ResolutionRepository,
    private readonly taxonomy: TaxonomyCache,
    private readonly events: EventRecorder,
  ) {}

  /** `create` makes a new business with id `businessId`; otherwise the business must exist. */
  async write(
    businessId: string,
    sources: readonly NormalizedSource[],
    options: {
      readonly create: boolean;
      /** Receives the golden fields this write changed (not called for a new business). */
      readonly onChanged?: (fields: readonly string[]) => void;
    },
  ): Promise<Business> {
    const golden = computeGolden(sources);
    const name = golden.fields.find((f) => f.value.field === 'displayName');
    let business: Business;
    if (options.create) {
      if (!name?.provenance) throw new Error('A golden record needs a name');
      business = Business.create({
        id: businessId,
        name: BusinessName.parse((name.value.value as BusinessName).display),
        countryCode: sources.find((s) => s.countryCode)?.countryCode ?? null,
        provenance: name.provenance,
      });
    } else {
      const existing = await this.businesses.getById(businessId);
      if (!existing) throw new Error(`Business ${businessId} not found for recompute`);
      business = existing;
    }

    const fallback = {
      source: sources[0]?.provider ?? 'import',
      sourceRef: null,
      confidence: 0,
      observedAt: new Date(
        sources
          .map((s) => s.observedAt)
          .sort()
          .at(-1) ?? 0,
      ),
    } as const;
    for (const { value, provenance } of golden.fields)
      business.updateField(value, provenance ?? fallback, ALWAYS);

    const snapshot = await this.taxonomy.get();
    const categories = golden.categories.flatMap((c) => {
      const category = snapshot.bySlug.get(c.slug);
      return category
        ? [{ categoryId: category.id, isPrimary: c.isPrimary, confidence: c.confidence, source: c.source }]
        : [];
    });
    const primary = categories.find((c) => c.isPrimary);
    if (!primary && categories[0]) categories[0] = { ...categories[0], isPrimary: true };
    business.setPrimaryCategory(categories.find((c) => c.isPrimary)?.categoryId ?? null);

    const existingContacts = options.create ? [] : await this.contacts.listByBusiness(businessId);
    const country = business.snapshot().countryCode;
    const keep: Array<{ type: (typeof golden.contacts)[number]['type']; normalizedValue: string }> = [];
    for (const contact of golden.contacts) {
      const normalizedValue = normalizeContact(contact.type, contact.value, country).normalizedValue;
      keep.push({ type: contact.type, normalizedValue });
      const current = existingContacts.find(
        (c) => c.type === contact.type && c.normalizedValue.toLowerCase() === normalizedValue.toLowerCase(),
      );
      if (
        current &&
        (current.publishedOnSite || !contact.publishedOnSite) &&
        // A crawl that sees it elsewhere now (another page, another form) refreshes where it is published.
        (contact.publishedContext === null ||
          samePublication(current.publishedContext, contact.publishedContext)) &&
        current.confidence >= contact.confidence
      ) {
        continue;
      }
      business.addContact({
        id: newId(),
        type: contact.type,
        value: contact.value,
        source: contact.source,
        sourceUrl: contact.sourceUrl,
        publishedOnSite: contact.publishedOnSite,
        publishedContext: contact.publishedContext,
        confidence: contact.confidence,
        submittedByOrgId: contact.submittedByOrgId,
      });
    }

    await this.businesses.save(business);
    const side: string[] = [];
    if (!options.create && (await this.resolution.deleteDerivedContactsExcept(businessId, keep)) > 0)
      side.push('contacts');
    if (await this.resolution.replaceCategories(businessId, categories)) side.push('categories');
    const hours = golden.hours;
    if (
      await this.resolution.replaceHours(businessId, hours?.value ?? [], hours?.source.provider ?? 'import')
    ) {
      side.push('hours');
    }
    business.noteChanged(side);
    const changed = await recordEvents(this.events, business);
    options.onChanged?.(changed);
    return business;
  }
}
