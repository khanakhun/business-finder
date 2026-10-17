import { BLOCK_SCHEMAS, type BlockType, blockVariants, LIMITS, type SiteSpec } from '@bf/site-schema';

// The blocks engine's deterministic half (BF-041): apply a model's plan to the starter site (order, variants, dropped
// optional blocks — checked, never trusted), list the free-text fields a page's copy may rewrite (fact values are not
// among them), apply the copy within limits, and put back the starter's text wherever a new one fails its checks.

type Block = SiteSpec['pages'][number]['blocks'][number];
type Localized = Record<string, string>;

/** Blocks a plan may not drop: they carry the business's facts or its contact. */
const KEPT_TYPES = new Set([
  'hero',
  'contact',
  'location',
  'hours',
  'menu',
  'services',
  'testimonials',
  'team',
  'booking',
]);

/** Free-text fields per block type, with their limit (fact-bound fields — names, quotes, prices — are not here). */
export const EDITABLE_FIELDS: Readonly<Partial<Record<BlockType, Readonly<Record<string, number>>>>> = {
  hero: { eyebrow: LIMITS.eyebrow.max, title: LIMITS.heroTitle.max, subtitle: LIMITS.heroSubtitle.max },
  highlights: { heading: LIMITS.heading.max },
  services: { heading: LIMITS.heading.max, intro: LIMITS.intro.max },
  menu: { heading: LIMITS.heading.max, intro: LIMITS.intro.max, note: LIMITS.note.max },
  about: { heading: LIMITS.heading.max, body: LIMITS.body.max },
  gallery: { heading: LIMITS.heading.max },
  testimonials: { heading: LIMITS.heading.max },
  hours: { heading: LIMITS.heading.max, note: LIMITS.note.max },
  location: { heading: LIMITS.heading.max, note: LIMITS.note.max },
  contact: { heading: LIMITS.heading.max, intro: LIMITS.intro.max },
  cta_banner: { title: LIMITS.heading.max, text: LIMITS.intro.max },
  faq: { heading: LIMITS.heading.max },
  team: { heading: LIMITS.heading.max },
  booking: { heading: LIMITS.heading.max, intro: LIMITS.intro.max },
};

export interface PlannedBlock {
  readonly id: string;
  readonly variant: string;
  readonly intent: string;
}
export interface PlannedPage {
  readonly id: string;
  readonly blocks: readonly PlannedBlock[];
}

export interface AppliedPlan {
  readonly spec: SiteSpec;
  /** Block id → what it should say. */
  readonly intents: ReadonlyMap<string, string>;
  /** Choices refused (an unknown id, a variant the type does not have…). */
  readonly refused: readonly string[];
}

/** The plan applied to the starter: order and variants as planned where valid; kept blocks never dropped. */
export function applyPlan(starter: SiteSpec, plan: readonly PlannedPage[]): AppliedPlan {
  const spec = structuredClone(starter);
  const intents = new Map<string, string>();
  const refused: string[] = [];
  for (const page of spec.pages) {
    const planned = plan.find((candidate) => candidate.id === page.id);
    if (!planned) continue;
    const byId = new Map(page.blocks.map((block) => [block.id, block]));
    const ordered: Block[] = [];
    for (const step of planned.blocks) {
      const block = byId.get(step.id);
      if (!block || ordered.includes(block)) {
        refused.push(`${page.id}: unknown or repeated block ${step.id}`);
        continue;
      }
      const variants = blockVariants(block.type as BlockType);
      if (step.variant !== block.variant) {
        if (variants.includes(step.variant)) (block as { variant: string }).variant = step.variant;
        else refused.push(`${page.id}/${block.id}: no variant ${step.variant} for ${block.type}`);
      }
      intents.set(block.id, step.intent.slice(0, 200));
      ordered.push(block);
    }
    for (const block of page.blocks)
      if (!ordered.includes(block) && KEPT_TYPES.has(block.type)) {
        refused.push(`${page.id}/${block.id}: ${block.type} kept (carries facts)`);
        ordered.push(block);
      }
    // The hero stays first.
    const hero = ordered.findIndex((block) => block.type === 'hero');
    if (hero > 0) ordered.unshift(...ordered.splice(hero, 1));
    page.blocks = ordered as typeof page.blocks;
  }
  return { spec, intents, refused };
}

export interface CopyField {
  readonly key: string;
  readonly maxChars: number;
  readonly current: Localized;
}
export interface CopyBlock {
  readonly blockId: string;
  readonly type: string;
  readonly fields: readonly CopyField[];
}

const isLocalized = (value: unknown): value is Localized =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every((text) => typeof text === 'string');

/** The page's rewritable fields that the starter filled. */
export function copyFields(page: SiteSpec['pages'][number]): CopyBlock[] {
  return page.blocks.flatMap((block) => {
    const editable = EDITABLE_FIELDS[block.type as BlockType];
    if (!editable) return [];
    const props = block.props as Record<string, unknown>;
    const fields = Object.entries(editable).flatMap(([key, maxChars]) =>
      isLocalized(props[key]) ? [{ key, maxChars, current: props[key] as Localized }] : [],
    );
    return fields.length ? [{ blockId: block.id, type: block.type, fields }] : [];
  });
}

export interface CopyAnswer {
  readonly blocks: readonly {
    blockId: string;
    fields: readonly { key: string; texts: Localized; factsUsed: readonly string[] }[];
  }[];
  readonly seo: { readonly title: Localized; readonly description: Localized };
}

/** A field's path in the spec (`pages[1].blocks[2].props.heading`), for matching validator issues. */
export const fieldPath = (pageIndex: number, blockIndex: number, key: string) =>
  `pages[${pageIndex}].blocks[${blockIndex}].props.${key}`;

/**
 * The page with the copy applied: a field changes only when the answer has a text for every locale within its limit
 * and the block and field exist; returns the paths changed.
 */
export function applyCopy(
  spec: SiteSpec,
  pageId: string,
  answer: CopyAnswer,
  knownFacts: ReadonlySet<string>,
): { changed: string[]; refused: string[] } {
  const changed: string[] = [];
  const refused: string[] = [];
  const pageIndex = spec.pages.findIndex((page) => page.id === pageId);
  const page = spec.pages[pageIndex];
  if (!page) return { changed, refused: [`no page ${pageId}`] };
  for (const blockAnswer of answer.blocks) {
    const blockIndex = page.blocks.findIndex((block) => block.id === blockAnswer.blockId);
    const block = page.blocks[blockIndex];
    if (!block) {
      refused.push(`${pageId}: no block ${blockAnswer.blockId}`);
      continue;
    }
    const editable = EDITABLE_FIELDS[block.type as BlockType] ?? {};
    const props = block.props as Record<string, unknown>;
    for (const field of blockAnswer.fields) {
      const max = editable[field.key];
      if (max === undefined || !isLocalized(props[field.key])) {
        refused.push(`${block.id}.${field.key}: not a rewritable field`);
        continue;
      }
      const texts = spec.locales.map((locale) => field.texts[locale]?.trim() ?? '');
      if (texts.some((text) => !text || text.length > max)) {
        refused.push(`${block.id}.${field.key}: missing a locale or over ${max} characters`);
        continue;
      }
      if (field.factsUsed.some((id) => !knownFacts.has(id))) {
        refused.push(`${block.id}.${field.key}: cites a fact that does not exist`);
        continue;
      }
      props[field.key] = Object.fromEntries(
        spec.locales.map((locale, index) => [locale, texts[index] as string]),
      );
      changed.push(fieldPath(pageIndex, blockIndex, field.key));
    }
  }
  const seo = page.seo as { title: Localized; description: Localized };
  for (const [key, max] of [
    ['title', LIMITS.seoTitle.max],
    ['description', LIMITS.seoDescription.max],
  ] as const) {
    const texts = spec.locales.map((locale) => answer.seo[key][locale]?.trim() ?? '');
    if (texts.every((text) => text && text.length <= max)) {
      seo[key] = Object.fromEntries(spec.locales.map((locale, index) => [locale, texts[index] as string]));
      changed.push(`pages[${pageIndex}].seo.${key}`);
    }
  }
  return { changed, refused };
}

/**
 * Puts back the starter's text for every changed field an issue points into (by block id: the plan may have moved
 * blocks); returns the paths restored.
 */
export function revertFields(
  spec: SiteSpec,
  starter: SiteSpec,
  changed: readonly string[],
  issuePaths: readonly string[],
): string[] {
  const restored: string[] = [];
  for (const path of changed) {
    if (
      !issuePaths.some(
        (issue) => issue === path || issue.startsWith(`${path}.`) || issue.startsWith(`${path}[`),
      )
    )
      continue;
    const match = /^pages\[(\d+)\](?:\.blocks\[(\d+)\]\.props\.(\w+)|\.seo\.(\w+))$/.exec(path);
    if (!match) continue;
    const page = spec.pages[Number(match[1])];
    const starterPage = starter.pages.find((candidate) => candidate.id === page?.id);
    if (!page || !starterPage) continue;
    if (match[4]) {
      (page.seo as Record<string, unknown>)[match[4]] = structuredClone(
        (starterPage.seo as Record<string, unknown>)[match[4]],
      );
    } else {
      const block = page.blocks[Number(match[2])];
      const original = starterPage.blocks.find((candidate) => candidate.id === block?.id);
      if (!block || !original) continue;
      (block.props as Record<string, unknown>)[match[3] as string] = structuredClone(
        (original.props as Record<string, unknown>)[match[3] as string],
      );
    }
    restored.push(path);
  }
  return restored;
}

/** The catalog summary the plan sees: each block type's variants and when to use them. */
export function catalogSummary(
  types: readonly string[],
  describe: (type: BlockType) => Record<string, string>,
) {
  return [...new Set(types)]
    .filter((type): type is BlockType => type in BLOCK_SCHEMAS)
    .map((type) => ({ type, variants: describe(type) }));
}
