import { z } from 'zod';
import { LIMITS } from '../limits.ts';
import { FactIdSchema, localized } from '../localized.ts';
import { block, heading, intro } from './common.ts';

export const HoursBlockSchema = block(
  'hours',
  ['table', 'compact'],
  {
    heading: heading('E.g. "Opening hours".').optional(),
    note: localized(LIMITS.note.max, 'An extra line.').optional(),
  },
  'Opening hours from `contact.hours`. Requires hours.',
);

export const LocationBlockSchema = block(
  'location',
  ['map_split', 'map_full', 'address_only'],
  {
    heading: heading('E.g. "Find us".').optional(),
    showDirections: z.boolean().describe('Show a directions button (needs an address or coordinates).'),
    note: localized(LIMITS.note.max, 'E.g. "Parking behind the shop".').optional(),
  },
  'Where the business is, from `contact.address` and `contact.geo`.',
);

export const ContactBlockSchema = block(
  'contact',
  ['split', 'centered'],
  {
    heading: heading('E.g. "Contact us".'),
    intro: intro().optional(),
    showForm: z.boolean().describe('Show the contact form (needs `settings.contactForm.enabled`).'),
    channels: z
      .object({
        phone: z.boolean().describe('List the phone number.'),
        email: z.boolean().describe('List the e-mail address.'),
        whatsapp: z.boolean().describe('List WhatsApp.'),
      })
      .strict()
      .describe('Which contact channels to list (only those present in `contact`).'),
  },
  'How to reach the business. Needs at least one channel or the form.',
);

export const FaqBlockSchema = block(
  'faq',
  ['accordion', 'two_column'],
  {
    heading: heading('E.g. "Questions".').optional(),
    items: z
      .array(
        z
          .object({
            question: localized(LIMITS.faqQuestion.max, 'A question customers ask.'),
            answer: localized(
              LIMITS.faqAnswer.max,
              'The answer, from facts only; otherwise invite them to ask.',
            ),
            factIds: z.array(FactIdSchema).max(10).optional().describe('The facts the answer states.'),
          })
          .strict(),
      )
      .min(1)
      .max(12)
      .describe('The questions, one to twelve.'),
  },
  'Common questions. Answers may not state anything the facts do not support.',
);

export const SocialLinksBlockSchema = block(
  'social_links',
  ['icons', 'buttons'],
  { heading: heading('E.g. "Follow us".').optional() },
  'Links to the business’s profiles from `contact.socials`. Requires socials.',
);

export const RichTextBlockSchema = block(
  'rich_text',
  ['narrow', 'wide'],
  {
    heading: heading().optional(),
    body: localized(
      LIMITS.richText.max,
      'Limited markdown: paragraphs, **bold**, *italic*, "- " lists and links to the site\'s own pages as ' +
        '[label](page:<pageId>). No HTML, no other links.',
    ),
  },
  'Free text for legal notices or longer content.',
);
