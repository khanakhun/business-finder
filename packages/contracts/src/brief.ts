import { z } from 'zod';
import { OfferSchema } from './taxonomy.ts';

// The generation brief (BF-040): everything an engine needs to build a business's preview site, from facts only.
// Versioned (`briefVersion`); hints and selling points cite the fact or review-theme ids they rest on.

export const BRIEF_VERSION = 1;

const text = (max: number) => z.string().trim().min(1).max(max);
const locale = z.string().regex(/^[a-z]{2}$/);
/** A registry fact id (`fact_…`) or a review theme (`theme_<pain tag>`). */
const EvidenceRefSchema = z
  .string()
  .regex(/^(fact_[a-z_]+_[0-9a-f]{12}|theme_[a-z_]+|finding_[a-z0-9_.-]+)$/);

/** The site theme styles (BF-033 THEME_STYLES; contracts cannot import site-schema). */
export const BRIEF_STYLES = ['luxe', 'modern', 'warm', 'minimal', 'coastal'] as const;
export const BriefStyleSchema = z.enum(BRIEF_STYLES);
export type BriefStyle = z.infer<typeof BriefStyleSchema>;

export const BRIEF_TONES = ['friendly', 'refined', 'professional', 'energetic'] as const;
export const BriefToneSchema = z.enum(BRIEF_TONES);

export const MARKETS = ['luxury_tourism', 'tourism', 'residents', 'mixed'] as const;

export const PagePlanBlockSchema = z.object({
  type: text(40),
  variant: text(40).optional(),
  /** Why the block is there, or what fills it (fact kinds). */
  fills: z.array(text(40)).max(10).optional(),
});

export const PlannedPageSchema = z.object({
  slug: z.string().regex(/^(|[a-z0-9-]{1,40})$/),
  kind: z.enum(['home', 'menu', 'services', 'products', 'about', 'contact', 'booking', 'gallery']),
  blocks: z.array(PagePlanBlockSchema).min(1).max(20),
});

export const PagePlanSchema = z.object({
  id: text(60),
  /** The taxonomy prefix the plan matched (`food_drink.cafe`), or `default`. */
  matched: text(80),
  pages: z.array(PlannedPageSchema).min(1).max(8),
  /** Pages of the template that had too few facts and were folded into another page. */
  collapsed: z.array(z.object({ kind: text(20), into: text(20), reason: text(200) })).max(8),
});
export type PagePlan = z.infer<typeof PagePlanSchema>;

export const BRIEF_WARNING_CODES = [
  'no_display_phone',
  'no_display_email',
  'no_contact_channel',
  'no_hours',
  'no_large_image',
  'single_locale',
  'no_services',
  'no_owner_site_facts',
  'few_facts',
] as const;

export const GenerationBriefSchema = z
  .object({
    briefVersion: z.literal(BRIEF_VERSION),
    businessId: z.uuid(),
    identity: z.object({
      name: text(200),
      nameFactId: EvidenceRefSchema.nullable(),
      categoryPath: z.string().max(200).nullable(),
      categoryLabel: z.object({ en: z.string().max(100), fr: z.string().max(100) }).nullable(),
      locality: z.string().max(100).nullable(),
      area: z.string().max(100).nullable(),
      /** From display facts only (tagline, about summary as published); null when none. */
      description: z.string().max(600).nullable(),
    }),
    offer: z.object({
      id: OfferSchema,
      /** What the new site improves over the current one (audit findings); messaging focus, never site copy. */
      improvements: z.array(z.object({ ref: EvidenceRefSchema, text: text(200) })).max(10),
    }),
    audience: z.object({
      market: z.enum(MARKETS),
      hints: z
        .array(z.object({ text: text(200), evidence: z.array(EvidenceRefSchema).min(1).max(10) }))
        .max(6),
    }),
    locales: z.object({ available: z.array(locale).min(1).max(4), default: locale }),
    pagePlan: PagePlanSchema,
    sellingPoints: z
      .array(z.object({ text: text(160), evidence: z.array(EvidenceRefSchema).min(1).max(6) }))
      .max(6),
    painPoints: z.array(z.object({ tag: text(60), remedy: text(200) })).max(8),
    design: z.object({
      style: BriefStyleSchema,
      reasons: z.array(text(200)).max(5),
      palette: z.object({
        primary: z.string().regex(/^#[0-9a-f]{6}$/i),
        accent: z.string().regex(/^#[0-9a-f]{6}$/i),
        source: z.enum(['brand', 'category', 'style']),
      }),
      imagery: text(200),
      density: z.enum(['compact', 'comfortable', 'airy']),
    }),
    constraints: z.object({
      tone: BriefToneSchema,
      noInventedFacts: z.literal(true),
      neutralCopyWhenMissing: z.literal(true),
      frenchTypography: z.boolean(),
      doNotMention: z.array(text(200)).max(20),
      maxHeadlineChars: z.number().int().positive(),
      maxParagraphChars: z.number().int().positive(),
    }),
    /** Operator instructions (a workspace member), sanitized; never the business's or a crawl's words. */
    extraInstructions: z.string().max(500).nullable(),
    warnings: z.array(z.object({ code: z.enum(BRIEF_WARNING_CODES), message: text(300) })).max(20),
  })
  .meta({ id: 'GenerationBrief' });
export type GenerationBrief = z.infer<typeof GenerationBriefSchema>;

/** Page kinds a custom page list may use (the plan's catalog). */
export const PLANNED_PAGE_KINDS = [
  'home',
  'menu',
  'services',
  'products',
  'about',
  'contact',
  'booking',
  'gallery',
] as const;

/** What a person may change before a generation (BF-040; validated and applied by the brief builder). */
export const BriefOverridesSchema = z
  .object({
    locales: z.array(locale).min(1).max(4).optional(),
    /** A page plan template id, or a custom list of page kinds (home first). */
    pagePlanId: z
      .string()
      .regex(/^[a-z0-9_-]{1,60}$/)
      .optional(),
    pages: z.array(z.enum(PLANNED_PAGE_KINDS)).min(1).max(8).optional(),
    style: BriefStyleSchema.optional(),
    tone: BriefToneSchema.optional(),
    extraInstructions: z.string().max(500).optional(),
  })
  .strict()
  .refine((overrides) => !overrides.pages || overrides.pages[0] === 'home', {
    message: 'A custom page list starts with home',
    path: ['pages'],
  })
  .refine((overrides) => !overrides.pages || new Set(overrides.pages).size === overrides.pages.length, {
    message: 'Each page kind once',
    path: ['pages'],
  })
  .meta({ id: 'BriefOverrides' });
export type BriefOverrides = z.infer<typeof BriefOverridesSchema>;

export const GenerationBriefQuerySchema = z
  .object({
    offer: OfferSchema.optional(),
    locales: z
      .string()
      .regex(/^[a-z]{2}(,[a-z]{2}){0,3}$/)
      .optional()
      .describe('Comma-separated, e.g. "fr,en".'),
    style: BriefStyleSchema.optional(),
  })
  .meta({ id: 'GenerationBriefQuery' });
export type GenerationBriefQuery = z.infer<typeof GenerationBriefQuerySchema>;

/** The brief a generation would start from, with the registry's counts (the generation UI previews it). */
export const GenerationBriefPreviewSchema = z
  .object({
    brief: GenerationBriefSchema,
    registry: z.object({
      display: z.number().int().nonnegative(),
      internal: z.number().int().nonnegative(),
      byKind: z.record(z.string(), z.object({ display: z.number().int(), internal: z.number().int() })),
    }),
    /** Page plan templates a person may pick instead. */
    pagePlans: z.array(z.object({ id: z.string(), matched: z.array(z.string()) })),
  })
  .meta({ id: 'GenerationBriefPreview' });
export type GenerationBriefPreview = z.infer<typeof GenerationBriefPreviewSchema>;
