import { z } from 'zod';
import { sha256Hex, stableJson } from './encoding.ts';

// A business's fact registry (BF-040): every value a generated site may state, with where it was read, how sure we
// are and whether it may be displayed. Sites name facts by id (BF-033 `factId`); `facts.json` in a generation
// workspace holds the display facts only, mapped onto BF-033's registry kinds by `toSiteFactKind`.

export const REGISTRY_FACT_KINDS = [
  'name',
  'tagline',
  'about_summary',
  'address',
  'geo',
  'phone',
  'email',
  'whatsapp',
  'website',
  'social',
  'hours',
  'service',
  'price',
  'menu_section',
  'menu_item',
  'testimonial',
  'team_member',
  'year_founded',
  'award',
  'language_spoken',
  'amenity',
  'payment_method',
  'booking_provider',
  'area_served',
  'category',
  'brand_color',
  'logo',
] as const;
export const RegistryFactKindSchema = z.enum(REGISTRY_FACT_KINDS);
export type RegistryFactKind = z.infer<typeof RegistryFactKindSchema>;

/**
 * Where a fact was read. `owner_site` and `jsonld`: the business's own website; `open_data`: OSM / Overture with
 * attribution; `golden_record`: our merged record (its own provenance decides); `user`: asserted by a workspace member;
 * `provider_restricted`: a provider whose terms forbid display (Google, Foursquare Places API…).
 */
export const FACT_SOURCES = [
  'owner_site',
  'jsonld',
  'open_data',
  'golden_record',
  'user',
  'provider_restricted',
] as const;
export const FactSourceSchema = z.enum(FACT_SOURCES);
export type FactSource = z.infer<typeof FactSourceSchema>;

export const FACT_USAGES = ['display', 'internal'] as const;
export const FactUsageSchema = z.enum(FACT_USAGES);
export type FactUsage = z.infer<typeof FactUsageSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);
const locale = z.string().regex(/^[a-z]{2}$/);
const https = z.url().refine((value) => /^https?:\/\//.test(value), 'http(s) only');

const WeekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Typed values per kind (structured where a site renders them structurally). */
export const FactValueSchemas = {
  geo: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  hours: z.object({
    weekly: z.array(z.object({ day: WeekdaySchema, opens: time, closes: time })).max(28),
    note: text(200).optional(),
  }),
  price: z.object({
    amount: z.number().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    unit: text(40).optional(),
    /** The service or menu item it is the price of. */
    serviceRef: text(120).optional(),
    label: text(120).optional(),
  }),
  social: z.object({ network: text(30), url: https }),
  testimonial: z.object({ quote: text(600), attribution: text(80), sourcePage: https }),
  team_member: z.object({ name: text(60), role: text(80).optional() }),
  year_founded: z.number().int().min(1800).max(2100),
  booking_provider: z.object({ url: https, provider: text(60) }),
  menu_item: z.object({ name: text(120), description: text(300).optional(), section: text(80).optional() }),
  brand_color: z.string().regex(/^#[0-9a-f]{6}$/i),
} as const;

const base = {
  id: z.string().regex(/^fact_[a-z_]+_[0-9a-f]{12}$/),
  locale: locale.optional(),
  source: FactSourceSchema,
  /** A URL, a field of a record, or the member who asserted it. */
  sourceRef: z.string().max(500).nullable(),
  /** The words on the page that state it (≤ 25 words), for verified extractions. */
  evidence: z.string().max(400).optional(),
  confidence: z.number().min(0).max(1),
  observedAt: z.iso.datetime(),
  usage: FactUsageSchema,
};

const typed = <K extends keyof typeof FactValueSchemas>(kind: K) =>
  z.object({ ...base, kind: z.literal(kind), value: FactValueSchemas[kind] });
type TextKind = Exclude<RegistryFactKind, keyof typeof FactValueSchemas>;
const textKinds = REGISTRY_FACT_KINDS.filter((kind) => !(kind in FactValueSchemas)) as TextKind[];

export const RegistryFactSchema = z
  .discriminatedUnion('kind', [
    typed('geo'),
    typed('hours'),
    typed('price'),
    typed('social'),
    typed('testimonial'),
    typed('team_member'),
    typed('year_founded'),
    typed('booking_provider'),
    typed('menu_item'),
    typed('brand_color'),
    z.object({ ...base, kind: z.enum(textKinds as [TextKind, ...TextKind[]]), value: text(2000) }),
  ])
  .meta({ id: 'RegistryFact' });
export type RegistryFact = z.infer<typeof RegistryFactSchema>;

/** The schema a value of `kind` must satisfy (free text for the kinds without a structure). */
export function factValueSchema(kind: RegistryFactKind): z.ZodType {
  return kind in FactValueSchemas ? FactValueSchemas[kind as keyof typeof FactValueSchemas] : text(2000);
}

/** A stable id: the kind and a hash of the normalized value and where it was read. */
export async function registryFactId(
  kind: RegistryFactKind,
  value: unknown,
  sourceRef: string | null,
): Promise<string> {
  const hash = await sha256Hex(`${kind}\u0000${stableJson(value).toLowerCase()}\u0000${sourceRef ?? ''}`);
  return `fact_${kind}_${hash.slice(0, 12)}`;
}

/** The BF-033 kind a registry kind becomes in a site's `facts.json` (undefined: not stated by sites). */
export function toSiteFactKind(kind: RegistryFactKind): string | undefined {
  const map: Partial<Record<RegistryFactKind, string>> = {
    name: 'business_name',
    phone: 'phone',
    email: 'email',
    whatsapp: 'whatsapp',
    address: 'address',
    geo: 'geo',
    hours: 'hours',
    social: 'social',
    booking_provider: 'booking_url',
    service: 'service',
    price: 'price',
    menu_item: 'menu_item',
    testimonial: 'testimonial',
    team_member: 'team_member',
    year_founded: 'year',
    award: 'award',
    // Text the business states about itself: sites may quote it, the validator checks it like any fact.
    tagline: 'other',
    about_summary: 'other',
    menu_section: 'other',
    amenity: 'other',
    language_spoken: 'other',
    payment_method: 'other',
    area_served: 'other',
  };
  return map[kind];
}

/** A member's own statement about a business (the workspace overlay; the global graph stays clean). */
export const OrgBusinessFactSchema = z
  .object({
    id: z.uuid(),
    kind: RegistryFactKindSchema,
    value: z.unknown(),
    locale: locale.nullable(),
    note: z.string().max(500).nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'OrgBusinessFact' });
export type OrgBusinessFact = z.infer<typeof OrgBusinessFactSchema>;

export const CreateOrgBusinessFactRequestSchema = z
  .object({
    kind: RegistryFactKindSchema,
    value: z.unknown(),
    locale: locale.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'CreateOrgBusinessFactRequest' });
export type CreateOrgBusinessFactRequest = z.infer<typeof CreateOrgBusinessFactRequestSchema>;

export const UpdateOrgBusinessFactRequestSchema = z
  .object({
    value: z.unknown().optional(),
    locale: locale.nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .meta({ id: 'UpdateOrgBusinessFactRequest' });
export type UpdateOrgBusinessFactRequest = z.infer<typeof UpdateOrgBusinessFactRequestSchema>;

/** The merged registry of a business for a workspace: global facts plus the workspace's own (overlay wins). */
export const BusinessFactsSchema = z
  .object({
    businessId: z.uuid(),
    facts: z.array(RegistryFactSchema),
    overlay: z.array(OrgBusinessFactSchema),
    stats: z.object({
      display: z.number().int().nonnegative(),
      internal: z.number().int().nonnegative(),
      byKind: z.partialRecord(RegistryFactKindSchema, z.number().int().nonnegative()),
    }),
  })
  .meta({ id: 'BusinessFacts' });
export type BusinessFacts = z.infer<typeof BusinessFactsSchema>;
