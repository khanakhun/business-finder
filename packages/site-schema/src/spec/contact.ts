import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { FactIdSchema, HttpsUrlSchema, localized, plainText } from './localized.ts';

// The business's contact facts (BF-033): the single source for the header, footer, contact block and call/e-mail/
// WhatsApp/directions/booking actions. Every value comes from the fact registry and names its fact (required: a
// contact detail is never invented).

const fact = FactIdSchema.describe(
  'The fact this value comes from (required: never invent a contact detail).',
);

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .describe('A time as HH:MM (24 h).');

const OpeningSchema = z
  .object({ open: time.describe('Opening time, HH:MM.'), close: time.describe('Closing time, HH:MM.') })
  .strict()
  .describe(
    'One opening span, e.g. { "open": "09:00", "close": "12:30" }. A close before the open ends after midnight.',
  );

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const HoursSchema = z
  .object({
    weekly: z
      .object(
        Object.fromEntries(
          WEEKDAYS.map((day) => [
            day,
            z.array(OpeningSchema).max(3).describe(`Opening spans on ${day}; empty when closed.`),
          ]),
        ) as Record<(typeof WEEKDAYS)[number], z.ZodArray<typeof OpeningSchema>>,
      )
      .strict()
      .describe('Opening spans per weekday; an empty list means closed that day.'),
    note: localized(
      LIMITS.note.max,
      'Exceptions in plain words (holidays, season), e.g. "Closed in September".',
    ).optional(),
    factId: fact,
  })
  .strict()
  .describe('Opening hours as the business publishes them.')
  .meta({ id: 'Hours' });

export const AddressSchema = z
  .object({
    street: plainText(120, 'Street and number, e.g. "12 rue du Port".').optional(),
    postalCode: plainText(20, 'Postal code, e.g. "97133".').optional(),
    locality: plainText(100, 'Town or district, e.g. "Gustavia".'),
    region: plainText(100, 'Region or island, when it helps.').optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .describe('ISO 3166-1 alpha-2 country code, e.g. "BL".'),
    formatted: plainText(300, 'The address on one line, as the business writes it.'),
    factId: fact,
  })
  .strict()
  .describe('The postal address.')
  .meta({ id: 'Address' });

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

const e164 = (what: string) =>
  z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/)
    .describe(`${what} in E.164, e.g. "+590590270000".`);

export const ContactSchema = z
  .object({
    phone: z
      .object({ value: e164('The phone number'), factId: fact })
      .strict()
      .optional()
      .describe('The main phone line.'),
    email: z
      .object({ value: z.email().max(254).describe('The public e-mail address.'), factId: fact })
      .strict()
      .optional()
      .describe('The public e-mail address.'),
    whatsapp: z
      .object({ value: e164('The WhatsApp number'), factId: fact })
      .strict()
      .optional()
      .describe('WhatsApp.'),
    address: AddressSchema.optional(),
    geo: z
      .object({
        lat: z.number().min(-90).max(90).describe('Latitude.'),
        lng: z.number().min(-180).max(180).describe('Longitude.'),
        factId: fact,
      })
      .strict()
      .optional()
      .describe('Coordinates of the entrance (for the map and directions).'),
    hours: HoursSchema.optional(),
    socials: z
      .array(
        z
          .object({
            network: z.enum(SOCIAL_NETWORKS).describe('The network.'),
            url: HttpsUrlSchema.describe("The business's own profile URL on that network (no query string)."),
            factId: fact,
          })
          .strict(),
      )
      .max(8)
      .optional()
      .describe("The business's own social profiles (the URL's host must be the network's)."),
    bookingUrl: z
      .object({ value: HttpsUrlSchema.describe('The booking page URL.'), factId: fact })
      .strict()
      .optional()
      .describe("The business's existing online booking page (a known booking provider or its own domain)."),
  })
  .strict()
  .describe('Contact facts. Leave a channel out when the business does not publish it; never invent one.')
  .meta({ id: 'Contact' });
export type Contact = z.infer<typeof ContactSchema>;
