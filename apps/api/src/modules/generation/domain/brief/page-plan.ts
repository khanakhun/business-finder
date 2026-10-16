import type { PagePlan, RegistryFactKind } from '@bf/contracts';
import { z } from 'zod';

// Page plans (BF-040): data-driven templates per taxonomy prefix (`page-plans/*.yaml`, the most specific match wins).
// A page or block lists what it needs (display facts of some kinds, images); a page without enough facts collapses
// into another page (its `section` blocks and `fallback` move there), a block without enough facts is left out —
// never filled with filler.

const KindSchema = z.string().regex(/^[a-z_]+$/);

const RequirementSchema = z
  .object({
    /** Display facts of any of these kinds, at least `min` of them (default 1). */
    kinds: z.array(KindSchema).min(1).optional(),
    min: z.number().int().positive().optional(),
    /** Image candidates (≥ 1200 px wide for a hero, any for a gallery). */
    images: z.number().int().positive().optional(),
  })
  .strict();
export type Requirement = z.infer<typeof RequirementSchema>;

const PlanBlockSchema = z
  .object({
    type: z.string().regex(/^[a-z_]+$/),
    variant: z.string().regex(/^[a-z_]+$/),
    /** Variant to use when the requirement for the main one fails (e.g. hero without a photo). */
    otherwise: z
      .string()
      .regex(/^[a-z_]+$/)
      .optional(),
    requires: RequirementSchema.optional(),
    /** Kept, as a section of another page, when its page collapses. */
    section: z.boolean().optional(),
    fills: z.array(KindSchema).max(10).optional(),
  })
  .strict();
type PlanBlock = z.infer<typeof PlanBlockSchema>;

const PlanPageSchema = z
  .object({
    kind: z.enum(['home', 'menu', 'services', 'products', 'about', 'contact', 'booking', 'gallery']),
    slug: z.string().regex(/^(|[a-z0-9-]{1,40})$/),
    requires: RequirementSchema.optional(),
    /** The page that receives this one's sections when it collapses (default home). */
    collapseInto: z.enum(['home', 'about', 'contact', 'services']).optional(),
    /** Blocks added to the receiving page instead, when this one collapses ("Our café" instead of a menu). */
    fallback: z.array(PlanBlockSchema).max(4).optional(),
    blocks: z.array(PlanBlockSchema).min(1).max(20),
  })
  .strict();

export const PagePlanTemplateSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,60}$/),
    /** Taxonomy path prefixes (`food_drink`, `lodging.villa_rental_agency`); `default` matches everything. */
    match: z.array(z.string().regex(/^(default|[a-z_]+(\.[a-z_]+)*)$/)).min(1),
    pages: z.array(PlanPageSchema).min(1).max(8),
  })
  .strict()
  .refine(
    (plan) => plan.pages[0]?.kind === 'home' && plan.pages[0].slug === '',
    'The first page is home ("")',
  )
  .refine(
    (plan) => new Set(plan.pages.map((page) => page.kind)).size === plan.pages.length,
    'One page per kind',
  );
export type PagePlanTemplate = z.infer<typeof PagePlanTemplateSchema>;

/** What the business has to show: display facts per kind, image candidates. */
export interface PlanInputs {
  readonly facts: Partial<Record<RegistryFactKind, number>>;
  readonly images: number;
  readonly largeImages: number;
}

/** The template whose prefix matches the category path on the most segments; `default` otherwise. */
export function selectTemplate(
  templates: readonly PagePlanTemplate[],
  categoryPath: string | null,
): { template: PagePlanTemplate; matched: string } {
  const segments = categoryPath?.split('.') ?? [];
  let best: { template: PagePlanTemplate; matched: string; depth: number } | undefined;
  for (const template of templates)
    for (const prefix of template.match) {
      if (prefix === 'default') {
        if (!best) best = { template, matched: 'default', depth: 0 };
        continue;
      }
      const parts = prefix.split('.');
      const fits = parts.length <= segments.length && parts.every((part, index) => segments[index] === part);
      if (fits && (!best || parts.length > best.depth))
        best = { template, matched: prefix, depth: parts.length };
    }
  if (!best) throw new Error('No default page plan');
  return { template: best.template, matched: best.matched };
}

export function met(requirement: Requirement | undefined, inputs: PlanInputs, hero = false): boolean {
  if (!requirement) return true;
  if (requirement.kinds) {
    const count = requirement.kinds.reduce(
      (sum, kind) => sum + (inputs.facts[kind as RegistryFactKind] ?? 0),
      0,
    );
    if (count < (requirement.min ?? 1)) return false;
  }
  if (requirement.images && (hero ? inputs.largeImages : inputs.images) < requirement.images) return false;
  return true;
}

const TRAILING = new Set(['contact', 'location', 'hours', 'social_links']);

function resolveBlock(block: PlanBlock, inputs: PlanInputs) {
  if (met(block.requires, inputs, block.type === 'hero'))
    return { type: block.type, variant: block.variant, ...(block.fills ? { fills: block.fills } : {}) };
  if (block.otherwise)
    return { type: block.type, variant: block.otherwise, ...(block.fills ? { fills: block.fills } : {}) };
  return undefined;
}

/** The plan for this business: pages with enough facts, the others folded into their receiving page. */
export function resolvePlan(template: PagePlanTemplate, matched: string, inputs: PlanInputs): PagePlan {
  const kept = template.pages.filter((page, index) => index === 0 || met(page.requires, inputs));
  const pages = kept.map((page) => ({
    kind: page.kind,
    slug: page.slug,
    blocks: page.blocks.flatMap((block) => resolveBlock(block, inputs) ?? []),
  }));
  const collapsed: PagePlan['collapsed'] = [];
  for (const page of template.pages) {
    if (kept.includes(page)) continue;
    const target = pages.find((candidate) => candidate.kind === (page.collapseInto ?? 'home')) ?? pages[0];
    if (!target) continue;
    const moved = [...page.blocks.filter((block) => block.section), ...(page.fallback ?? [])].flatMap(
      (block) => resolveBlock(block, inputs) ?? [],
    );
    const present = new Set(target.blocks.map((block) => block.type));
    const added = moved.filter((block) => !present.has(block.type));
    // Before the contact details that close the page.
    let at = target.blocks.length;
    while (at > 1 && TRAILING.has(target.blocks[at - 1]?.type ?? '')) at--;
    target.blocks.splice(at, 0, ...added);
    collapsed.push({
      kind: page.kind,
      into: target.kind,
      reason: `Not enough facts for a ${page.kind} page (${describe(page.requires)})`,
    });
  }
  return { id: template.id, matched, pages: pages.filter((page) => page.blocks.length > 0), collapsed };
}

function describe(requirement: Requirement | undefined): string {
  if (!requirement) return 'no requirement';
  const parts = [];
  if (requirement.kinds) parts.push(`${requirement.min ?? 1}+ of ${requirement.kinds.join('/')}`);
  if (requirement.images) parts.push(`${requirement.images}+ images`);
  return parts.join(', ');
}
