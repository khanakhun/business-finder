import { z } from 'zod';
import { defineTask } from '../define-task.ts';
import { untrusted } from '../untrusted.ts';

// The visual critic (BF-045, smart tier with vision): screenshots of a generated site (home at desktop 1280 px and
// mobile 390 px at 2×, one inner page at desktop) graded on an anchored 1–5 rubric, with the evidence for each
// criterion and the issues worth a repair — each targeted to a block of the outline and mapped to a strategy the
// engines know (BF-041/BF-044 repair). Thresholds are calibrated against human ratings (docs/quality/visual-rubric.md).

export const VISUAL_CRITERIA = [
  'hierarchy',
  'typography',
  'spacing',
  'imagery',
  'color',
  'cta',
  'mobile',
  'brand_fit',
  'originality',
] as const;
export type VisualCriterion = (typeof VISUAL_CRITERIA)[number];

/** The repair strategies an engine understands (BF-041 repair mode). */
export const VISUAL_FIXES = [
  'swap_hero_asset',
  'change_variant',
  'reduce_text',
  'merge_sections',
  'change_density',
  'adjust_accent',
  'reorder_sections',
  'other',
] as const;

export const VisualCriticInput = z.object({
  business: z.object({ name: z.string().max(200), category: z.string().max(100).nullable() }),
  /** The brief's direction: market (luxury, family…), tone, style family. */
  direction: z.object({ market: z.string().max(40), tone: z.string().max(40), style: z.string().max(40) }),
  /** The pages' blocks in order (ids the issues name). */
  outline: z
    .array(
      z.object({
        page: z.string().max(40),
        blocks: z
          .array(z.object({ id: z.string().max(80), type: z.string().max(40), variant: z.string().max(40) }))
          .max(20),
      }),
    )
    .max(8),
  /** What each image is, in order (e.g. "home, desktop 1280 px"). */
  screenshots: z.array(z.string().max(80)).min(1).max(4),
});
export type VisualCriticInput = z.input<typeof VisualCriticInput>;

const score = z.number().int().min(1).max(5);

export const VisualCriticOutput = z.object({
  criteria: z
    .array(
      z.object({
        criterion: z.enum(VISUAL_CRITERIA),
        score: score.describe('1, 3 and 5 are anchored in the rubric; 2 and 4 in between.'),
        evidence: z.string().max(300).describe('What in the screenshots justifies the score.'),
      }),
    )
    .length(VISUAL_CRITERIA.length)
    .describe('One entry per criterion, in the rubric’s order.'),
  issues: z
    .array(
      z.object({
        criterion: z.enum(VISUAL_CRITERIA),
        page: z.string().max(40).describe('The page id from the outline.'),
        blockId: z
          .string()
          .max(80)
          .nullable()
          .describe('The block id from the outline, or null for the whole page.'),
        message: z.string().max(400).describe('What is wrong, concretely.'),
        fix: z.enum(VISUAL_FIXES).describe('The repair strategy that addresses it.'),
        suggestion: z
          .string()
          .max(300)
          .describe('The change, in one sentence (e.g. "use the terrace photo").'),
      }),
    )
    .max(10)
    .describe('The problems worth a repair, most important first.'),
  summary: z.string().max(400),
});
export type VisualCriticOutput = z.infer<typeof VisualCriticOutput>;

export const QualityVisualCritic = defineTask({
  name: 'quality.visual_critic',
  kind: 'vision',
  tier: 'smart',
  prompt: 'quality.visual_critic.v1',
  input: VisualCriticInput,
  output: VisualCriticOutput,
  temperature: 0,
  maxOutputTokens: 3_000,
  timeoutMs: 90_000,
  // Mobile shots are 780 × 2600 px (390 px at 2×, about three screens): legible at this size.
  maxImageDimension: 2_600,
  evalSet: 'quality.visual_critic',
  variables: (input) => ({
    business: untrusted('business', JSON.stringify(input.business), { maxChars: 400 }),
    direction: JSON.stringify(input.direction),
    outline: JSON.stringify(input.outline),
    screenshots: input.screenshots.map((label, index) => `${index + 1}. ${label}`).join('\n'),
  }),
});
