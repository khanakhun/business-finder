import { z } from 'zod';
import { defineEvent } from './events.ts';
import { LatLngSchema } from './geo.ts';
import { BusinessId } from './ids.ts';
import { cursorPage } from './pagination.ts';
import { IsoDateTimeSchema } from './time.ts';
import { PostalAddressSchema } from './workspace.ts';

// Business graph (BF-014): global facts about businesses (ADR-0008) and the workspace's link to them.

/** Where a fact came from. Survivorship priorities per provider come with entity resolution (BF-016). */
export const SOURCE_PROVIDERS = [
  'google_places',
  'overture',
  'foursquare',
  'osm',
  'gmaps_scraper',
  'website',
  'manual',
  'import',
] as const;
export const SourceProviderSchema = z.enum(SOURCE_PROVIDERS);
export type SourceProvider = z.infer<typeof SourceProviderSchema>;

export const OPERATING_STATUSES = [
  'operational',
  'closed_temporarily',
  'closed_permanently',
  'unknown',
] as const;
export const OperatingStatusSchema = z.enum(OPERATING_STATUSES);
export type OperatingStatus = z.infer<typeof OperatingStatusSchema>;

/** Sales stages of a workspace's business (DOMAIN.md §3.1); transitions are enforced in the CRM (BF-024). */
export const PIPELINE_STATUSES = [
  'new',
  'qualified',
  'disqualified',
  'contacted',
  'engaged',
  'meeting',
  'proposal',
  'won',
  'lost',
] as const;
export const PipelineStatusSchema = z.enum(PIPELINE_STATUSES);
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;

export const ADDED_VIA = ['discovery', 'search', 'manual', 'import'] as const;
export const AddedViaSchema = z.enum(ADDED_VIA);
export type AddedVia = z.infer<typeof AddedViaSchema>;

/** Provenance of one golden-record field (ARCHITECTURE.md §6.2). */
export const ProvenanceSchema = z
  .object({
    value: z.unknown(),
    source: SourceProviderSchema,
    sourceRef: z.string().nullable().describe("The provider's id for the record the value came from."),
    confidence: z.number().min(0).max(1),
    observedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Provenance' });
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const CONTACT_TYPES = ['email', 'phone', 'whatsapp', 'website_form', 'social'] as const;
export const ContactTypeSchema = z.enum(CONTACT_TYPES);
export type ContactType = z.infer<typeof ContactTypeSchema>;

export const VERIFICATION_STATUSES = [
  'unknown',
  'valid',
  'invalid',
  'catch_all',
  'risky',
  'disposable',
] as const;
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);

export const ContactSchema = z
  .object({
    id: z.uuid(),
    type: ContactTypeSchema,
    value: z.string(),
    normalizedValue: z.string(),
    subtype: z
      .string()
      .describe(
        'email: generic | personal | department | unknown; phone: mobile | landline | unknown; social: network.',
      ),
    personName: z
      .string()
      .nullable()
      .describe('Only when published by the business itself (data minimization).'),
    source: SourceProviderSchema,
    sourceUrl: z.string().nullable(),
    publishedOnSite: z.boolean(),
    confidence: z.number().min(0).max(1),
    verificationStatus: VerificationStatusSchema,
    verifiedAt: IsoDateTimeSchema.nullable(),
    firstSeenAt: IsoDateTimeSchema,
    lastSeenAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Contact' });
export type Contact = z.infer<typeof ContactSchema>;

/** The workspace's relationship with a business (minimal until the CRM, BF-024). */
export const OrgBusinessStateSchema = z
  .object({
    pipelineStatus: PipelineStatusSchema,
    addedVia: AddedViaSchema,
    doNotContact: z.boolean(),
    trackedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'OrgBusinessState' });
export type OrgBusinessState = z.infer<typeof OrgBusinessStateSchema>;

export const BusinessSummarySchema = z
  .object({
    id: BusinessId,
    displayName: z.string(),
    primaryCategoryId: z.uuid().nullable(),
    operatingStatus: OperatingStatusSchema,
    websiteUrl: z.string().nullable(),
    primaryPhone: z.string().nullable().describe('E.164.'),
    locality: z.string().nullable(),
    countryCode: z.string().nullable(),
    location: LatLngSchema.nullable(),
    ratingAvg: z.number().nullable(),
    ratingCount: z.number().int().nullable(),
    pipelineStatus: PipelineStatusSchema,
  })
  .meta({ id: 'BusinessSummary' });
export type BusinessSummary = z.infer<typeof BusinessSummarySchema>;

export const BusinessPageSchema = cursorPage(BusinessSummarySchema).meta({ id: 'BusinessPage' });
export type BusinessPage = z.infer<typeof BusinessPageSchema>;

export const MEDIA_KINDS = ['photo', 'logo', 'screenshot_desktop', 'screenshot_mobile', 'og_image'] as const;
export const MEDIA_LICENSES = [
  'owner_site',
  'provider_restricted',
  'stock',
  'ai_generated',
  'unknown',
] as const;

export const BusinessDetailSchema = BusinessSummarySchema.extend({
  formattedAddress: z.string().nullable(),
  address: PostalAddressSchema.partial().nullable(),
  postalCode: z.string().nullable(),
  priceLevel: z.number().int().min(0).max(4).nullable(),
  attributes: z.record(z.string(), ProvenanceSchema).describe('Provenance of each golden field.'),
  dataQuality: z.number().int().min(0).max(100).nullable(),
  categories: z.array(z.object({ categoryId: z.uuid(), isPrimary: z.boolean(), confidence: z.number() })),
  hours: z.array(
    z.object({
      weekday: z.number().int().min(0).max(6).describe('0 = Monday.'),
      opensAt: z.string().describe('HH:MM'),
      closesAt: z.string().describe('HH:MM'),
    }),
  ),
  media: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(MEDIA_KINDS),
      license: z.enum(MEDIA_LICENSES),
      url: z.string().nullable(),
    }),
  ),
  contacts: z.array(ContactSchema),
  orgState: OrgBusinessStateSchema,
  firstSeenAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema,
  version: z.number().int().describe('Optimistic concurrency version.'),
}).meta({ id: 'BusinessDetail' });
export type BusinessDetail = z.infer<typeof BusinessDetailSchema>;

/** `POST /v1/businesses`: a business the workspace adds by hand (a `manual` source record). */
export const CreateManualBusinessRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    websiteUrl: z.string().trim().min(1).max(500).optional(),
    phone: z.string().trim().min(3).max(40).optional(),
    email: z.email().max(254).optional(),
    formattedAddress: z.string().trim().min(1).max(300).optional(),
    locality: z.string().trim().min(1).max(100).optional(),
    postalCode: z.string().trim().min(1).max(20).optional(),
    location: LatLngSchema.optional(),
  })
  .meta({ id: 'CreateManualBusinessRequest' });
export type CreateManualBusinessRequest = z.infer<typeof CreateManualBusinessRequestSchema>;

export const TrackBusinessRequestSchema = z
  .object({ addedVia: AddedViaSchema.default('manual'), addedRef: z.string().max(200).optional() })
  .meta({ id: 'TrackBusinessRequest' });
export type TrackBusinessRequest = z.infer<typeof TrackBusinessRequestSchema>;

export const AddContactRequestSchema = z
  .object({
    type: ContactTypeSchema,
    value: z.string().trim().min(1).max(500),
  })
  .meta({
    id: 'AddContactRequest',
    // Contacts are global facts (ADR-0008); names of people belong in the workspace's own CRM notes (BF-024).
    description: 'A contact point the business publishes (no person names: contacts are shared facts).',
  });
export type AddContactRequest = z.infer<typeof AddContactRequestSchema>;

export const ContactListSchema = z.object({ items: z.array(ContactSchema) }).meta({ id: 'ContactList' });
export type ContactList = z.infer<typeof ContactListSchema>;

// --- Events ----------------------------------------------------------------------------------------------------

export const BusinessCreated = defineEvent(
  'business.created',
  1,
  z.object({ businessId: BusinessId, source: SourceProviderSchema }),
);

export const BusinessUpdated = defineEvent(
  'business.updated',
  1,
  z.object({ businessId: BusinessId, fields: z.array(z.string()).min(1) }),
);

export const BusinessMerged = defineEvent(
  'business.merged',
  1,
  z.object({ businessId: BusinessId, intoId: BusinessId }),
);
