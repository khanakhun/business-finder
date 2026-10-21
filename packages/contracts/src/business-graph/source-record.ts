import { z } from 'zod';
import { OperatingStatusSchema, SourceProviderSchema } from '../business.ts';
import { EMAIL_FOUND_AS, PUBLISHED_PAGE_KINDS } from '../email-verification.ts';
import { LatLngSchema } from '../geo.ts';
import { IsoDateTimeSchema } from '../time.ts';

// What providers (BF-018/BF-019), crawls (BF-027) and manual adds hand to ingestion (BF-016). Values are raw: the
// pipeline normalizes them. Everything here is untrusted input.

const text = (max: number) => z.string().trim().min(1).max(max);

export const SourceRecordSchema = z
  .object({
    provider: SourceProviderSchema,
    providerRef: text(300).describe("The provider's id for the place (unique per provider)."),
    fetchedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional().describe('Until when the provider allows keeping the raw data.'),
    name: text(300),
    providerCategories: z
      .array(z.object({ key: text(200), label: text(200).optional() }))
      .max(30)
      .default([]),
    location: LatLngSchema.optional(),
    address: z
      .object({
        line1: text(300).optional(),
        line2: text(300).optional(),
        city: text(120).optional(),
        postalCode: text(20).optional(),
        region: text(120).optional(),
        countryCode: z
          .string()
          .regex(/^[A-Za-z]{2}$/)
          .optional(),
        formatted: text(400).optional(),
      })
      .optional(),
    phones: z.array(text(40)).max(10).default([]),
    website: text(2_000).optional(),
    emails: z.array(text(254)).max(20).default([]),
    socials: z.array(text(500)).max(20).default([]),
    contactPages: z
      .array(
        z.object({
          value: text(500),
          pageUrl: text(2_000),
          pageKind: z.enum(PUBLISHED_PAGE_KINDS).optional(),
          foundAs: z.enum(EMAIL_FOUND_AS).optional(),
        }),
      )
      .max(80)
      .optional()
      .describe(
        'Crawls (BF-027): the page that shows each phone, e-mail or social (value as given above). Optional, ' +
          'so records without it keep their content hash.',
      ),
    hours: z
      .array(
        z.object({
          weekday: z.number().int().min(0).max(6).describe('0 = Monday.'),
          opensAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          closesAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        }),
      )
      .max(50)
      .optional(),
    rating: z.number().min(0).max(5).optional(),
    reviewCount: z.number().int().min(0).optional(),
    priceLevel: z.number().int().min(0).max(4).optional(),
    operatingStatus: OperatingStatusSchema.optional(),
    /** Provider-specific extras kept for later enrichment (opaque). */
    attributes: z.record(z.string(), z.unknown()).optional(),
    /** The provider payload as received; stored, never interpreted by ingestion. */
    raw: z.unknown().optional(),
  })
  .meta({ id: 'SourceRecord' });
export type SourceRecord = z.output<typeof SourceRecordSchema>;
export type SourceRecordInput = z.input<typeof SourceRecordSchema>;

/** `skipped_closed`: a new place its source reports permanently closed is stored as a record, not as a business. */
export const INGEST_OUTCOMES = [
  'created',
  'merged',
  'possible_duplicate',
  'unchanged',
  'skipped_closed',
  'failed',
] as const;
export const IngestOutcomeSchema = z.enum(INGEST_OUTCOMES);
export type IngestOutcome = z.infer<typeof IngestOutcomeSchema>;
