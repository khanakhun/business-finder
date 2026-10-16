import { z } from 'zod';
import { LIMITS } from '../limits.ts';
import { ElementIdSchema, FactIdSchema, localized } from '../localized.ts';

const pascal = (type: string) =>
  type.replace(/(^|_)([a-z])/g, (_match, _sep, letter: string) => letter.toUpperCase());

/** A block: an id, its type, a design variant and its props. */
export function block<T extends string, V extends readonly [string, ...string[]], P extends z.ZodRawShape>(
  type: T,
  variants: V,
  props: P,
  description: string,
) {
  return z
    .object({
      id: ElementIdSchema,
      type: z.literal(type).describe('The block type.'),
      variant: z.enum(variants).describe('The block layout; see the block catalog for when to use each.'),
      props: z.object(props).strict().describe(`The ${type} block's content.`),
    })
    .strict()
    .describe(description)
    .meta({ id: `${pascal(type)}Block` });
}

export const heading = (description = 'Section heading, e.g. "Our services".') =>
  localized(LIMITS.heading.max, description);
export const intro = (description = 'One or two sentences introducing the section.') =>
  localized(LIMITS.intro.max, description);
export const AssetRefSchema = ElementIdSchema.describe('The id of an asset in `assets`.');

/** A price as the business publishes it, backed by a price fact (never an estimate). */
export const PriceSchema = z
  .object({
    amount: z.number().nonnegative().max(1_000_000).describe('The amount, as published (e.g. 65).'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .describe('ISO 4217, e.g. "EUR".'),
    unit: z
      .enum(['each', 'per_person', 'per_hour', 'per_night'])
      .optional()
      .describe('What the price is for.'),
    from: z.boolean().optional().describe('A starting price ("from €90").'),
    factId: FactIdSchema.describe('The price fact (required: never estimate a price).'),
  })
  .strict()
  .describe('A published price; `factId` must name a price fact with the same amount.')
  .meta({ id: 'Price' });
export type Price = z.infer<typeof PriceSchema>;
