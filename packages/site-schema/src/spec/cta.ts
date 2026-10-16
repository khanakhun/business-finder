import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { HttpsUrlSchema, localized, PageIdSchema } from './localized.ts';

const label = () => localized(LIMITS.ctaLabel.max, 'A short verb phrase, e.g. "Book a table", "Réserver".');

/**
 * A call to action. `call`, `email`, `whatsapp`, `directions` and `booking` resolve from the site's contact facts;
 * `page` links to a page of the site; `url` only to an allowlisted host (the business's own domain or a known booking
 * provider). Each kind carries only what it uses.
 */
export const CtaActionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z
          .enum(['call', 'email', 'whatsapp', 'booking', 'directions'])
          .describe('Resolved from the contact facts: the phone, e-mail, WhatsApp, booking page or address.'),
        label: label(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('page').describe('Opens a page of the site.'),
        label: label(),
        pageId: PageIdSchema.describe('The page it opens.'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('url').describe("Opens the business's own domain or its booking provider."),
        label: label(),
        url: HttpsUrlSchema.describe('An allowlisted https URL.'),
      })
      .strict(),
  ])
  .describe('A button or link. Prefer `call`, `booking` or `page` over `url`.')
  .meta({ id: 'CtaAction' });
export type CtaAction = z.infer<typeof CtaActionSchema>;
