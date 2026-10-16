import { z } from 'zod';
import type { Offer } from './taxonomy.ts';
import { IsoDateTimeSchema } from './time.ts';

// Review mining (BF-029, DOMAIN.md "Pain signal"): review text is licensed content. A workspace turns the reviews
// it may use into aggregated, anonymous insights — pain signals from a fixed taxonomy, sentiment, owner response
// rate, rating trend — and keeps short paraphrased evidence only where the source allows it, until it expires.
// Reviewer identities are never stored or sent to a model (security.md §7).

/** The fixed pain-signal taxonomy (stable ids: scoring features and outreach themes refer to them). */
export const PAIN_SIGNAL_TAGS = [
  'booking_friction',
  'unreachable_by_phone',
  'slow_or_no_reply',
  'website_broken_or_outdated',
  'no_online_menu_or_prices',
  'hard_to_find_info',
  'language_barrier',
  'payment_friction',
  'long_wait_times',
  'inconsistent_hours',
  'poor_communication',
  'positive_strong_reputation',
  'other',
] as const;
export const PainSignalTagSchema = z.enum(PAIN_SIGNAL_TAGS);
export type PainSignalTag = z.infer<typeof PainSignalTagSchema>;

export interface PainSignalDefinition {
  /** `positive` for a strength (a reputation to show off), `pain` for a problem an offer can solve. */
  readonly polarity: 'pain' | 'positive' | 'neutral';
  readonly label: { readonly en: string; readonly fr: string };
  readonly description: { readonly en: string; readonly fr: string };
  /** Offers that address it, most relevant first (scoring BF-031 and outreach BF-051 read this). */
  readonly offers: readonly Offer[];
}

export const PAIN_SIGNAL_DEFINITIONS: Readonly<Record<PainSignalTag, PainSignalDefinition>> = {
  booking_friction: {
    polarity: 'pain',
    label: { en: 'Booking friction', fr: 'Réservation difficile' },
    description: {
      en: 'Customers struggle to book or reserve: no online booking, broken forms, lost reservations.',
      fr: 'Les clients ont du mal à réserver : pas de réservation en ligne, formulaire cassé, réservation perdue.',
    },
    offers: ['booking_system', 'ai_receptionist', 'new_website'],
  },
  unreachable_by_phone: {
    polarity: 'pain',
    label: { en: 'Unreachable by phone', fr: 'Injoignable par téléphone' },
    description: {
      en: 'Calls go unanswered, the number is wrong or the voicemail is full.',
      fr: 'Les appels restent sans réponse, le numéro est faux ou la messagerie est pleine.',
    },
    offers: ['ai_receptionist'],
  },
  slow_or_no_reply: {
    polarity: 'pain',
    label: { en: 'Slow or no reply', fr: 'Réponse lente ou absente' },
    description: {
      en: 'E-mails, messages or contact forms are answered late or never.',
      fr: 'Les e-mails, messages ou formulaires de contact reçoivent une réponse tardive, ou aucune.',
    },
    offers: ['ai_receptionist', 'booking_system'],
  },
  website_broken_or_outdated: {
    polarity: 'pain',
    label: { en: 'Website broken or outdated', fr: 'Site cassé ou obsolète' },
    description: {
      en: 'The website is down, broken on mobile, out of date — or missing when customers look for it.',
      fr: 'Le site est en panne, inutilisable sur mobile, obsolète — ou absent quand les clients le cherchent.',
    },
    offers: ['website_redesign', 'new_website'],
  },
  no_online_menu_or_prices: {
    polarity: 'pain',
    label: { en: 'No menu or prices online', fr: 'Pas de carte ni de prix en ligne' },
    description: {
      en: 'Customers cannot find the menu, price list or rates online.',
      fr: 'Les clients ne trouvent ni la carte, ni les tarifs en ligne.',
    },
    offers: ['new_website', 'website_redesign'],
  },
  hard_to_find_info: {
    polarity: 'pain',
    label: { en: 'Hard-to-find information', fr: 'Informations difficiles à trouver' },
    description: {
      en: 'Hours, address, directions or parking are hard to find or wrong online.',
      fr: 'Horaires, adresse, accès ou stationnement sont introuvables ou faux en ligne.',
    },
    offers: ['local_seo', 'new_website'],
  },
  language_barrier: {
    polarity: 'pain',
    label: { en: 'Language barrier', fr: 'Barrière de la langue' },
    description: {
      en: 'Customers could not communicate in their language (English or French).',
      fr: 'Les clients n’ont pas pu échanger dans leur langue (français ou anglais).',
    },
    offers: ['ai_receptionist', 'website_redesign'],
  },
  payment_friction: {
    polarity: 'pain',
    label: { en: 'Payment friction', fr: 'Paiement compliqué' },
    description: {
      en: 'Cards refused, cash only, no online payment or deposit hassle.',
      fr: 'Carte refusée, espèces uniquement, pas de paiement en ligne ou acompte compliqué.',
    },
    offers: ['booking_system'],
  },
  long_wait_times: {
    polarity: 'pain',
    label: { en: 'Long waits', fr: 'Attente longue' },
    description: {
      en: 'Long waits for a table, service or an appointment.',
      fr: 'Longue attente pour une table, le service ou un rendez-vous.',
    },
    offers: ['booking_system', 'ai_receptionist'],
  },
  inconsistent_hours: {
    polarity: 'pain',
    label: { en: 'Inconsistent hours', fr: 'Horaires non respectés' },
    description: {
      en: 'Closed during posted hours, or the hours online differ from reality.',
      fr: 'Fermé pendant les horaires affichés, ou horaires en ligne différents de la réalité.',
    },
    offers: ['local_seo', 'new_website'],
  },
  poor_communication: {
    polarity: 'pain',
    label: { en: 'Poor communication', fr: 'Communication défaillante' },
    description: {
      en: 'Unclear information, misunderstandings, changes or cancellations not communicated.',
      fr: 'Informations floues, malentendus, changements ou annulations non communiqués.',
    },
    offers: ['ai_receptionist', 'booking_system'],
  },
  positive_strong_reputation: {
    polarity: 'positive',
    label: { en: 'Strong reputation', fr: 'Excellente réputation' },
    description: {
      en: 'Enthusiastic praise and strong recommendations — a reputation worth showing online.',
      fr: 'Éloges enthousiastes et fortes recommandations — une réputation à mettre en valeur en ligne.',
    },
    offers: ['new_website', 'local_seo'],
  },
  other: {
    polarity: 'neutral',
    label: { en: 'Other complaint', fr: 'Autre reproche' },
    description: {
      en: 'A complaint outside the taxonomy (food, cleanliness, prices…): counted, never used by offers.',
      fr: 'Un reproche hors taxonomie (cuisine, propreté, prix…) : compté, jamais utilisé par les offres.',
    },
    offers: [],
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Licensing gates (ADR-0013)

/** Where review text comes from. `manual`: pasted by a member of the workspace. */
export const REVIEW_SOURCES = ['google_places', 'gmaps_scraper', 'manual'] as const;
export const ReviewSourceSchema = z.enum(REVIEW_SOURCES);
export type ReviewSource = z.infer<typeof ReviewSourceSchema>;

/**
 * What a source's review text may be used for: nothing; insights derived on the fly (text discarded after
 * classification); or insights plus the text itself (still without reviewer identities).
 */
export const REVIEWS_USAGES = ['none', 'transient_insights', 'store_text'] as const;
export const ReviewsUsageSchema = z.enum(REVIEWS_USAGES);
export type ReviewsUsage = z.infer<typeof ReviewsUsageSchema>;

const USAGE_RANK: Readonly<Record<ReviewsUsage, number>> = { none: 0, transient_insights: 1, store_text: 2 };

/** The more restrictive of two usages (a workspace choice never exceeds what the source's terms allow). */
export function narrowerUsage(a: ReviewsUsage, b: ReviewsUsage): ReviewsUsage {
  return USAGE_RANK[a] <= USAGE_RANK[b] ? a : b;
}

export interface ReviewSourceLicensing {
  /** The most the source's terms (or our policy) allow. */
  readonly maxUsage: ReviewsUsage;
  /** Until the workspace decides. */
  readonly defaultUsage: ReviewsUsage;
  /** Days derived insights and evidence may be kept; null when there is no limit. */
  readonly retentionDays: number | null;
  /** Extra gate before the workspace may enable it. */
  readonly requires: 'owner_acknowledgement' | 'scraper_gates' | null;
  readonly notes: string;
}

/** Google Places, scraper and manual paste: what each source may be used for (verified 2026-10-16, BF-029 notes). */
export const REVIEW_SOURCE_LICENSING: Readonly<Record<ReviewSource, ReviewSourceLicensing>> = {
  google_places: {
    maxUsage: 'transient_insights',
    defaultUsage: 'none',
    retentionDays: 30,
    requires: 'owner_acknowledgement',
    notes:
      'Place Details `reviews` (at most 5, Enterprise + Atmosphere SKU). The Google Maps Platform Terms ' +
      '§3.2.3 forbid saving user reviews and creating content from Google Maps content: off until an owner ' +
      'acknowledges the warning; text is never stored and insights expire after 30 days (caching limit).',
  },
  gmaps_scraper: {
    maxUsage: 'transient_insights',
    defaultUsage: 'none',
    retentionDays: 30,
    requires: 'scraper_gates',
    notes:
      'Reviews read on demand by the self-hosted scraper (only where the scraper itself is allowed). No licence: ' +
      'text is never stored (BF-019 promise) and insights expire after 30 days.',
  },
  manual: {
    maxUsage: 'transient_insights',
    defaultUsage: 'transient_insights',
    retentionDays: null,
    requires: null,
    notes: 'Reviews pasted by a member: analysed on the fly, the text is not kept.',
  },
};

/**
 * The warning a workspace owner acknowledges before insights are derived from Google reviews (recorded in the
 * audit log with the terms URL and date). Changing the text means bumping the version.
 */
export const GOOGLE_REVIEWS_TERMS = {
  version: 1,
  url: 'https://cloud.google.com/maps-platform/terms',
  lastModified: '2026-08-26',
  warning: {
    en:
      'Deriving insights from Google reviews reads up to 5 reviews per business through the Place Details API ' +
      '(Enterprise + Atmosphere SKU, billed to your Google key). The Google Maps Platform Terms (§3.2.3, last ' +
      'modified 26 August 2026) forbid copying and saving user reviews and creating content based on Google Maps ' +
      'content; aggregated insights may fall under these restrictions. Business Finder never stores Google review ' +
      'text or reviewer identities, keeps derived insights for 30 days only and never uses Google content to ' +
      'train or test models. You enable it at your own risk and are responsible for complying with Google’s terms.',
    fr:
      'Analyser les avis Google lit jusqu’à 5 avis par établissement via l’API Place Details (SKU Enterprise + ' +
      'Atmosphere, facturé sur votre clé Google). Les conditions de Google Maps Platform (§3.2.3, modifiées le ' +
      '26 août 2026) interdisent de copier et d’enregistrer les avis des utilisateurs et de créer du contenu à ' +
      'partir du contenu Google Maps ; des analyses agrégées peuvent tomber sous ces restrictions. Business Finder ' +
      'n’enregistre jamais le texte des avis Google ni l’identité des auteurs, ne garde les analyses que 30 jours ' +
      'et n’utilise jamais le contenu Google pour entraîner ou tester des modèles. Vous l’activez à vos risques et ' +
      'êtes responsable du respect des conditions de Google.',
  },
} as const;

export const REVIEW_GATE_BLOCKERS = [
  /** The workspace has not enabled the source. */
  'not_enabled',
  /** Google: no owner acknowledgement of the current terms warning. */
  'acknowledgement',
  /** Google: no Places API key in the workspace vault. */
  'not_configured',
  /** Scraper: not deployed, workspace flag off, or its own warning not acknowledged. */
  'scraper_gates',
] as const;
export type ReviewGateBlocker = (typeof REVIEW_GATE_BLOCKERS)[number];

export const ReviewSourceGateSchema = z
  .object({
    source: ReviewSourceSchema,
    maxUsage: ReviewsUsageSchema.describe('The most the source’s terms allow.'),
    usage: ReviewsUsageSchema.describe('What the workspace chose (never above `maxUsage`).'),
    effective: ReviewsUsageSchema.describe('What applies now: `none` while a gate blocks the source.'),
    blockedBy: z.enum(REVIEW_GATE_BLOCKERS).nullable(),
    retentionDays: z.number().int().positive().nullable(),
  })
  .meta({ id: 'ReviewSourceGate' });
export type ReviewSourceGate = z.infer<typeof ReviewSourceGateSchema>;

export const ReviewSourcesStatusSchema = z
  .object({
    sources: z.array(ReviewSourceGateSchema),
    googleTerms: z.object({
      version: z.number().int(),
      url: z.string(),
      lastModified: z.iso.date(),
      warning: z.object({ en: z.string(), fr: z.string() }),
    }),
    googleAcknowledgement: z
      .object({
        userId: z.string().nullable(),
        acknowledgedAt: IsoDateTimeSchema,
        termsVersion: z.number().int(),
      })
      .nullable()
      .describe('The owner acknowledgement of the current Google terms warning, if any.'),
  })
  .meta({ id: 'ReviewSourcesStatus' });
export type ReviewSourcesStatus = z.infer<typeof ReviewSourcesStatusSchema>;

/** `PUT /v1/reviews/sources`: Google is enabled through its acknowledgement, manual paste is always on. */
export const UpdateReviewSourcesRequestSchema = z
  .object({
    gmapsScraper: z.enum(['none', 'transient_insights']).describe('Derive insights from scraped reviews.'),
  })
  .meta({ id: 'UpdateReviewSourcesRequest' });
export type UpdateReviewSourcesRequest = z.infer<typeof UpdateReviewSourcesRequestSchema>;

export const AcknowledgeGoogleReviewsRequestSchema = z
  .object({ termsVersion: z.number().int().min(1) })
  .meta({ id: 'AcknowledgeGoogleReviewsRequest' });
export type AcknowledgeGoogleReviewsRequest = z.infer<typeof AcknowledgeGoogleReviewsRequestSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Insights

/** Where a rating observation comes from: a review source, or the golden record's provider rating. */
export const RATING_OBSERVATION_SOURCES = ['google_places', 'gmaps_scraper', 'golden_record'] as const;
export type RatingObservationSource = (typeof RATING_OBSERVATION_SOURCES)[number];

export const RATING_TRENDS = ['up', 'flat', 'down', 'unknown'] as const;
export const RatingTrendSchema = z.enum(RATING_TRENDS);
export type RatingTrend = z.infer<typeof RatingTrendSchema>;

/** Evidence snippets are paraphrases (never quotes) of at most this many words. */
export const EVIDENCE_MAX_WORDS = 20;
/** Snippets kept per tag. */
export const EVIDENCE_PER_TAG = 3;

export const EvidenceSnippetSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(200)
      .describe(`A paraphrase of at most ${EVIDENCE_MAX_WORDS} words, not a quote.`),
    language: z.string().max(10),
    sourceRef: ReviewSourceSchema,
    expiresAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'EvidenceSnippet' });
export type EvidenceSnippet = z.infer<typeof EvidenceSnippetSchema>;

const TagCounts = z.partialRecord(PainSignalTagSchema, z.number().int().min(0));
const TagShares = z.partialRecord(PainSignalTagSchema, z.number().min(0).max(1));

export const ReviewInsightsSchema = z
  .object({
    businessId: z.uuid(),
    computedAt: IsoDateTimeSchema,
    sources: z.array(ReviewSourceSchema),
    sampleSize: z.number().int().min(0).describe('Reviews analysed (across sources still within retention).'),
    painCounts: TagCounts.describe('Reviews evidencing each tag.'),
    painShare: TagShares.describe('Share of analysed reviews evidencing each tag.'),
    sentimentAvg: z.number().min(-1).max(1).nullable(),
    ownerResponseRate: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe('Share of reviews with an owner reply (null when no source tells).'),
    ratingSnapshot: z
      .object({
        avg: z.number().min(0).max(5),
        count: z.number().int().min(0),
        observedAt: IsoDateTimeSchema,
      })
      .nullable(),
    ratingTrend: RatingTrendSchema,
    evidence: z.partialRecord(PainSignalTagSchema, z.array(EvidenceSnippetSchema).max(EVIDENCE_PER_TAG)),
    model: z.string(),
    promptVersion: z.number().int(),
    expiresAt: IsoDateTimeSchema.nullable().describe('When the insights from licensed sources expire.'),
  })
  .meta({ id: 'ReviewInsights' });
export type ReviewInsights = z.infer<typeof ReviewInsightsSchema>;

/** `GET /v1/businesses/:id/review-insights`. */
export const BusinessReviewInsightsSchema = z
  .object({
    insights: ReviewInsightsSchema.nullable(),
    sources: z.array(ReviewSourceGateSchema).describe('What this workspace may analyse now.'),
  })
  .meta({ id: 'BusinessReviewInsights' });
export type BusinessReviewInsights = z.infer<typeof BusinessReviewInsightsSchema>;

/** Reviews analysed per paste, and their size. */
export const MAX_PASTED_REVIEWS = 50;
export const MAX_REVIEW_CHARS = 2_000;

/** `POST /v1/businesses/:id/reviews/analyze`: reviews pasted by a member, analysed on the fly (never stored). */
export const AnalyzePastedReviewsRequestSchema = z
  .object({
    reviews: z
      .array(
        z.object({
          text: z.string().trim().min(1).max(MAX_REVIEW_CHARS),
          rating: z.number().int().min(1).max(5).optional(),
        }),
      )
      .min(1)
      .max(MAX_PASTED_REVIEWS),
  })
  .meta({ id: 'AnalyzePastedReviewsRequest' });
export type AnalyzePastedReviewsRequest = z.infer<typeof AnalyzePastedReviewsRequestSchema>;

/** Words of a text, lowercased, without punctuation (Unicode letters and digits). */
export function reviewWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Consecutive words an evidence snippet may share with its review before it counts as a quote. */
export const MAX_SHARED_RUN = 4;

/**
 * Why a model's evidence snippet cannot be kept (`null` when it can): longer than the limit, a quote of the review
 * (five or more words in a row), or still carrying a removed personal detail.
 */
export function evidenceProblem(snippet: string, review: string): 'too_long' | 'quote' | 'personal' | null {
  const words = reviewWords(snippet);
  if (words.length === 0 || words.length > EVIDENCE_MAX_WORDS) return 'too_long';
  if (/\[(person|email|phone|handle|link)\]|@\w|https?:\/\/|\d{6,}/iu.test(snippet)) return 'personal';
  const source = reviewWords(review);
  // Five words in a row copied make a quote — and so does a shorter snippet copied whole.
  const run = Math.min(MAX_SHARED_RUN + 1, words.length);
  const runs = new Set<string>();
  for (let k = 0; k + run <= source.length; k++) runs.add(source.slice(k, k + run).join(' '));
  for (let k = 0; k + run <= words.length; k++) {
    if (runs.has(words.slice(k, k + run).join(' '))) return 'quote';
  }
  return null;
}
