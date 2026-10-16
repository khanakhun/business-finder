import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { FactIdSchema, HttpsUrlSchema, localized } from './localized.ts';

// The business's contact facts (BF-033): the single source for the header, footer, contact block and call/e-mail/
// WhatsApp/directions/booking actions. Every value comes from the fact registry and names its fact.

const fact = FactIdSchema.optional();

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe('A time as HH:MM (24 h).');

const OpeningSchema = z
  .object({ open: time, close: time })
  .strict()
  .describe(
    'One opening span, e.g. { "open": "09:00", "close": "12:30" }. A close before the open ends after midnight.',
  );

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const HoursSchema = z
  .object({
    weekly: z
      .object(
        Object.fromEntries(WEEKDAYS.map((day) => [day, z.array(OpeningSchema).max(3)])) as Record<
          (typeof WEEKDAYS)[number],
          z.ZodArray<typeof OpeningSchema>
        >,
      )
      .strict()
      .describe('Opening spans per weekday; an empty list means closed that day.'),
    note: localized(
      LIMITS.note.max,
      'Exceptions in plain words (holidays, season), e.g. "Closed in September".',
    ).optional(),
    factId: fact,
  })
  .strict();

export const AddressSchema = z
  .object({
    street: z.string().trim().min(1).max(120).optional(),
    postalCode: z.string().trim().min(1).max(20).optional(),
    locality: z.string().trim().min(1).max(100),
    region: z.string().trim().min(1).max(100).optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .describe('ISO 3166-1 alpha-2 country code, e.g. "BL".'),
    formatted: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe('The address on one or two lines, as the business writes it.'),
    factId: fact,
  })
  .strict();

export const SOCIAL_NETWORKS = [
  'instagram',
  'facebook',
  'tiktok',
  'linkedin',
  'youtube',
  'x',
  'tripadvisor',
  'google',
] as const;

export const ContactSchema = z
  .object({
    phone: z
      .object({
        value: z
          .string()
          .regex(/^\+[1-9]\d{6,14}$/)
          .describe('E.164 phone number, e.g. "+590590270000".'),
        factId: fact,
      })
      .strict()
      .optional(),
    email: z
      .object({ value: z.email().max(254), factId: fact })
      .strict()
      .optional(),
    whatsapp: z
      .object({
        value: z
          .string()
          .regex(/^\+[1-9]\d{6,14}$/)
          .describe('E.164 WhatsApp number.'),
        factId: fact,
      })
      .strict()
      .optional(),
    address: AddressSchema.optional(),
    geo: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), factId: fact })
      .strict()
      .optional(),
    hours: HoursSchema.optional(),
    socials: z
      .array(z.object({ network: z.enum(SOCIAL_NETWORKS), url: HttpsUrlSchema, factId: fact }).strict())
      .max(8)
      .optional()
      .describe("The business's own social profiles (the URL's host must match the network)."),
    bookingUrl: z
      .object({ value: HttpsUrlSchema, factId: fact })
      .strict()
      .optional()
      .describe("The business's existing online booking page (a known booking provider or its own domain)."),
  })
  .strict()
  .describe('Contact facts. Leave a channel out when the business does not publish it; never invent one.');
export type Contact = z.infer<typeof ContactSchema>;
