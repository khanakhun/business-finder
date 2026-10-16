// Text length limits (BF-033): the hard maximum the schema enforces, and the target range the semantic validator
// recommends (a warning outside it). Shared with the editor (BF-037) and the agents' catalog.

export interface TextLimit {
  /** Longer is refused by the schema. */
  readonly max: number;
  /** Outside this range the validator warns (the text still renders). */
  readonly target?: readonly [number, number];
}

export const LIMITS = {
  brandName: { max: 60 },
  siteTitle: { max: 70, target: [20, 60] },
  siteDescription: { max: 200, target: [120, 160] },
  pageTitle: { max: 60, target: [3, 40] },
  seoTitle: { max: 70, target: [20, 60] },
  seoDescription: { max: 200, target: [120, 160] },
  navLabel: { max: 24 },
  ctaLabel: { max: 30, target: [2, 24] },
  eyebrow: { max: 40 },
  heroTitle: { max: 60, target: [4, 60] },
  heroSubtitle: { max: 160, target: [40, 160] },
  heading: { max: 80, target: [3, 60] },
  intro: { max: 300, target: [40, 240] },
  itemTitle: { max: 60 },
  itemText: { max: 240 },
  body: { max: 1500, target: [150, 1200] },
  quote: { max: 400, target: [20, 300] },
  faqQuestion: { max: 120 },
  faqAnswer: { max: 600, target: [40, 400] },
  tagline: { max: 120 },
  note: { max: 200 },
  alt: { max: 150, target: [5, 125] },
  richText: { max: 5000 },
} as const satisfies Record<string, TextLimit>;

export type LimitKey = keyof typeof LIMITS;

/** Structural limits (the schema enforces them; listed for agents and editors). */
export const COUNTS = {
  locales: [1, 4],
  pages: [1, 8],
  blocksPerPage: [1, 20],
  navigation: [0, 7],
  galleryAssets: [3, 12],
  assets: [0, 120],
} as const;
