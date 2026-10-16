import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { HttpsUrlSchema, localized, PageIdSchema } from './localized.ts';

/**
 * A call to action. `call`, `email`, `whatsapp`, `directions` and `booking` resolve from the site's contact facts;
 * `page` links to a page of the site; `url` only to an allowlisted host (the business's own domain or a known booking
 * provider).
 */
export const CtaActionSchema = z
  .object({
    kind: z.enum(['call', 'email', 'whatsapp', 'page', 'booking', 'directions', 'url']),
    label: localized(LIMITS.ctaLabel.max, 'A short verb phrase, e.g. "Book a table", "Réserver".'),
    pageId: PageIdSchema.optional().describe('The page a `page` action opens.'),
    url: HttpsUrlSchema.optional().describe('Only for `url` actions.'),
  })
  .strict()
  .describe('A button or link. Prefer `call`, `booking` or `page` over `url`.');
export type CtaAction = z.infer<typeof CtaActionSchema>;
