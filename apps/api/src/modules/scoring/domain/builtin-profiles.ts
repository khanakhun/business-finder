import {
  type Gate,
  type Offer,
  type ScoringProfileConfig,
  type ScoringProfileConfigInput,
  ScoringProfileConfigSchema,
} from '@bf/contracts';

// Built-in offer profiles (BF-031): versioned and read-only; a workspace duplicates one to customize it. Every
// weight's rationale is in docs/scoring/profiles.md — change both together and bump that profile's version in
// `BUILTIN_PROFILE_VERSIONS` (a new version is seeded; scores computed with the old one stay as they were). A test
// pins each version to a hash of its config, so an edit without a bump fails.

export const BUILTIN_PROFILE_VERSIONS: Readonly<Record<Offer, number>> = {
  new_website: 1,
  website_redesign: 1,
  ai_receptionist: 1,
  booking_system: 1,
  local_seo: 1,
};

/** Gates every built-in profile shares (do-not-contact is the engine's own). */
const COMMON_GATES: Gate[] = [
  {
    id: 'closed_permanently',
    when: { feature: 'operating_status', eq: 'closed_permanently' },
    effect: { type: 'exclude' },
    reason: { en: 'Permanently closed.', fr: 'Fermée définitivement.' },
  },
  {
    id: 'disqualified',
    when: { feature: 'pipeline_status', eq: 'disqualified' },
    effect: { type: 'exclude' },
    reason: { en: 'Disqualified in the pipeline.', fr: 'Disqualifiée dans le pipeline.' },
  },
  {
    // DECISION(BF-031): a customer stays visible for cross-selling, below cold prospects.
    id: 'already_customer',
    when: { feature: 'pipeline_status', eq: 'won' },
    effect: { type: 'cap', max: 40 },
    reason: {
      en: 'Already a customer: an upsell through the account, not a cold prospect.',
      fr: 'Déjà cliente : une vente additionnelle via le compte, pas une prospection.',
    },
  },
  {
    id: 'no_solicitation',
    when: { feature: 'no_solicitation_notice', eq: true },
    effect: { type: 'exclude' },
    reason: { en: 'The website asks not to be solicited.', fr: 'Le site demande à ne pas être démarché.' },
  },
  {
    id: 'closed_temporarily',
    when: { feature: 'operating_status', eq: 'closed_temporarily' },
    effect: { type: 'cap', max: 40 },
    reason: {
      en: 'Temporarily closed: wait until it reopens.',
      fr: 'Fermée temporairement : attendre la réouverture.',
    },
  },
  {
    id: 'offer_rarely_fits',
    when: { feature: 'category_offer_relevance', lt: 0.25 },
    effect: { type: 'cap', max: 30 },
    reason: {
      en: 'This offer rarely fits this kind of business.',
      fr: 'Cette offre convient rarement à ce type d’entreprise.',
    },
  },
  {
    id: 'unreachable',
    when: {
      all: [
        { feature: 'has_usable_email', eq: false },
        { feature: 'has_phone', eq: false },
        { feature: 'has_whatsapp', eq: false },
      ],
    },
    effect: { type: 'cap', max: 30 },
    reason: { en: 'No known way to reach them yet.', fr: 'Aucun moyen connu de les joindre pour l’instant.' },
  },
];

const notHaving = { kind: 'boolean', true: 0, false: 1 } as const;
const painUpTo = (share: number) => ({ kind: 'linear', min: 0, max: share }) as const;

const PROFILES: Record<Offer, ScoringProfileConfigInput> = {
  new_website: {
    offer: 'new_website',
    weights: {
      website_status: 40,
      category_offer_relevance: 15,
      review_count_log: 10,
      has_verified_email: 8,
      has_phone: 7,
      rating_avg: 5,
      tourism_facing: 5,
      'pain_share.hard_to_find_info': 5,
      'pain_share.website_broken_or_outdated': 5,
      appointment_based: 3,
      price_level: 3,
      has_whatsapp: 2,
      multi_location: -8,
    },
    transforms: {
      website_status: {
        kind: 'enumMap',
        map: { none: 1, parked: 1, social_only: 0.9, broken: 0.7, weak: 0.25, ok: 0, strong: 0 },
        default: 0,
      },
      review_count_log: { kind: 'linear', min: 0, max: 3 },
      rating_avg: { kind: 'linear', min: 3, max: 5 },
      'pain_share.hard_to_find_info': painUpTo(0.3),
      'pain_share.website_broken_or_outdated': painUpTo(0.3),
      price_level: { kind: 'linear', min: 1, max: 4 },
    },
    gates: [
      ...COMMON_GATES,
      {
        id: 'has_working_website',
        when: { feature: 'website_status', in: ['ok', 'strong'] },
        effect: { type: 'cap', max: 30 },
        reason: {
          en: 'Already has a working website: see the redesign offer.',
          fr: 'A déjà un site qui fonctionne : voir l’offre de refonte.',
        },
      },
    ],
    tiers: { A: 70, B: 50 },
  },
  website_redesign: {
    offer: 'website_redesign',
    weights: {
      website_status: 25,
      website_quality_score: 15,
      vision_overall: 10,
      psi_mobile_performance: 8,
      category_offer_relevance: 8,
      site_freshness_years: 7,
      lcp_mobile_seconds: 5,
      has_language_gap_for_market: 5,
      review_count_log: 5,
      'pain_share.website_broken_or_outdated': 5,
      has_verified_email: 5,
      has_https: 4,
      has_contact_form: 3,
      ad_pixels_present: 3,
      has_phone: 3,
      multi_location: -6,
    },
    transforms: {
      website_status: {
        kind: 'enumMap',
        map: { none: 0, parked: 0.2, social_only: 0.3, broken: 1, weak: 0.9, ok: 0.4, strong: 0 },
        default: 0,
      },
      website_quality_score: { kind: 'inverse', min: 20, max: 90 },
      vision_overall: { kind: 'inverse', min: 2, max: 9 },
      psi_mobile_performance: { kind: 'inverse', min: 20, max: 90 },
      site_freshness_years: { kind: 'linear', min: 1, max: 6 },
      lcp_mobile_seconds: { kind: 'linear', min: 2.5, max: 8 },
      review_count_log: { kind: 'linear', min: 0, max: 3 },
      'pain_share.website_broken_or_outdated': painUpTo(0.3),
      has_https: notHaving,
      has_contact_form: notHaving,
    },
    gates: [
      ...COMMON_GATES,
      {
        id: 'not_audited_yet',
        when: {
          all: [
            { feature: 'has_website', eq: true },
            { feature: 'website_status', isNull: true },
          ],
        },
        effect: { type: 'cap', max: 40 },
        reason: { en: 'The website is not audited yet.', fr: 'Le site n’est pas encore audité.' },
      },
      {
        id: 'no_website_to_redesign',
        when: { feature: 'website_status', in: ['none', 'parked', 'social_only'] },
        effect: { type: 'cap', max: 20 },
        reason: {
          en: 'No real website to redesign: see the new website offer.',
          fr: 'Pas de vrai site à refaire : voir l’offre de nouveau site.',
        },
      },
    ],
    tiers: { A: 65, B: 45 },
  },
  ai_receptionist: {
    offer: 'ai_receptionist',
    weights: {
      'pain_share.unreachable_by_phone': 20,
      category_offer_relevance: 15,
      'pain_share.slow_or_no_reply': 12,
      appointment_based: 12,
      has_phone: 8,
      review_count_log: 8,
      'pain_share.poor_communication': 5,
      'pain_share.language_barrier': 5,
      tourism_facing: 5,
      owner_response_rate: 5,
      has_verified_email: 4,
      has_whatsapp: 3,
      price_level: 3,
    },
    transforms: {
      'pain_share.unreachable_by_phone': painUpTo(0.25),
      'pain_share.slow_or_no_reply': painUpTo(0.25),
      'pain_share.poor_communication': painUpTo(0.25),
      'pain_share.language_barrier': painUpTo(0.2),
      review_count_log: { kind: 'linear', min: 0.5, max: 3 },
      owner_response_rate: { kind: 'inverse', min: 0, max: 0.8 },
      price_level: { kind: 'linear', min: 1, max: 4 },
    },
    gates: [
      ...COMMON_GATES,
      {
        id: 'no_phone_line',
        when: { feature: 'has_phone', eq: false },
        effect: { type: 'cap', max: 40 },
        reason: { en: 'No phone line to answer.', fr: 'Pas de ligne téléphonique à prendre en charge.' },
      },
    ],
    tiers: { A: 65, B: 45 },
  },
  booking_system: {
    offer: 'booking_system',
    weights: {
      has_booking_tool: 25,
      appointment_based: 15,
      category_offer_relevance: 15,
      'pain_share.booking_friction': 15,
      review_count_log: 7,
      'pain_share.long_wait_times': 5,
      has_verified_email: 5,
      tourism_facing: 4,
      has_website: 3,
      has_phone: 3,
    },
    // Unknown (no readable site, e.g. only a social page): no booking tool seen (capped while not checked).
    missing: { has_booking_tool: 1 },
    transforms: {
      has_booking_tool: notHaving,
      'pain_share.booking_friction': painUpTo(0.25),
      'pain_share.long_wait_times': painUpTo(0.25),
      review_count_log: { kind: 'linear', min: 0.5, max: 3 },
    },
    gates: [
      ...COMMON_GATES,
      {
        // The crawl did not say (not crawled yet, blocked, broken): "no tool" is a guess until it does.
        id: 'booking_not_checked',
        when: {
          all: [
            { feature: 'has_website', eq: true },
            { feature: 'has_booking_tool', isNull: true },
            { not: { feature: 'website_status', in: ['social_only', 'parked'] } },
          ],
        },
        effect: { type: 'cap', max: 40 },
        reason: {
          en: 'We could not check the website for online booking.',
          fr: 'Nous n’avons pas pu vérifier la réservation en ligne sur le site.',
        },
      },
      {
        id: 'already_books_online',
        when: { feature: 'has_booking_tool', eq: true },
        effect: { type: 'cap', max: 35 },
        reason: { en: 'Already takes bookings online.', fr: 'Prend déjà des réservations en ligne.' },
      },
    ],
    tiers: { A: 65, B: 45 },
  },
  local_seo: {
    offer: 'local_seo',
    weights: {
      category_offer_relevance: 12,
      'pain_share.hard_to_find_info': 12,
      rating_avg: 10,
      website_status: 10,
      has_language_gap_for_market: 10,
      tourism_facing: 10,
      review_count_log: 8,
      website_quality_score: 8,
      owner_response_rate: 6,
      has_verified_email: 5,
      multi_location: 4,
      has_phone: 3,
      'pain_share.positive_strong_reputation': 2,
    },
    transforms: {
      'pain_share.hard_to_find_info': painUpTo(0.25),
      rating_avg: { kind: 'linear', min: 3.5, max: 5 },
      website_status: {
        kind: 'enumMap',
        map: { none: 0.6, parked: 0.6, social_only: 0.7, broken: 0.6, weak: 0.8, ok: 0.6, strong: 0.3 },
        default: 0.5,
      },
      review_count_log: { kind: 'linear', min: 0.5, max: 2.5 },
      website_quality_score: { kind: 'inverse', min: 30, max: 95 },
      owner_response_rate: { kind: 'inverse', min: 0, max: 0.8 },
      'pain_share.positive_strong_reputation': painUpTo(0.5),
    },
    gates: COMMON_GATES,
    tiers: { A: 65, B: 45 },
  },
};

/** The built-in profiles, parsed (defaults applied, problems refused) and frozen. */
export const BUILTIN_PROFILES: Readonly<Record<Offer, ScoringProfileConfig>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PROFILES).map(([offer, input]) => [offer, ScoringProfileConfigSchema.parse(input)]),
  ) as Record<Offer, ScoringProfileConfig>,
);
