import { z } from 'zod';
import { OPERATING_STATUSES, PIPELINE_STATUSES } from './business.ts';
import { defineEvent } from './events.ts';
import { BusinessId } from './ids.ts';
import { defineJob } from './jobs.ts';
import { PAIN_SIGNAL_TAGS, type PainSignalTag } from './reviews.ts';
import { ScoreTierSchema } from './search-intent.ts';
import { OfferSchema } from './taxonomy.ts';
import { IsoDateTimeSchema } from './time.ts';
import { WEBSITE_STATUSES } from './website-audit.ts';

// Scoring (BF-031, DOMAIN.md "Feature vector", "Scoring profile", "Score / Tier"): a typed feature registry, offer
// profiles (weights, transforms, gates, tiers, reason templates) and explainable scores. The definitions here are
// shared with the profile editor (BF-032) and the outcome model (BF-059); how each feature is computed lives in the
// scoring domain.

// ---------------------------------------------------------------------------------------------------------------
// Features

export const FEATURE_GROUPS = ['presence', 'business', 'pain', 'reachability', 'workspace'] as const;
export type FeatureGroup = (typeof FEATURE_GROUPS)[number];

/** How a feature's value reads in a reason: `{value}` is replaced by the formatted value. */
export const FEATURE_UNITS = [
  'score100',
  'score10',
  'seconds',
  'years',
  'days',
  'share',
  'rating',
  'count',
  /** A log10(1 + n) value shown as the count n. */
  'log_count',
  'none',
] as const;
export type FeatureUnit = (typeof FEATURE_UNITS)[number];

interface Text {
  readonly en: string;
  readonly fr: string;
}

/**
 * Reason texts of a feature: by boolean or enum value (`true`, `false`, `closed_permanently`…), below or above the
 * feature's `pivot` (`below`, `above`), for any value (`value`, with `{value}`), or for a missing value a profile
 * filled in (`missing`). A contribution reads the most specific one there is, the profile's before the registry's;
 * a filled-in value reads only `missing` (never "null").
 */
export type ReasonTexts = Readonly<Partial<Record<string, Text>>>;

export interface FeatureDefinition {
  /** A short name (charts, tables, the editor). */
  readonly label: Text;
  readonly group: FeatureGroup;
  readonly type: 'number' | 'boolean' | 'enum';
  /** The values of an enum feature. */
  readonly values?: readonly string[];
  readonly unit: FeatureUnit;
  readonly description: Text;
  /** Where the value comes from (shown in the editor). */
  readonly source: string;
  /** The usual range of a number (the editor suggests transform bounds from it). */
  readonly range?: readonly [number, number];
  /** A number's reasons read `below` / `above` this value (e.g. sentiment around 0). */
  readonly pivot?: number;
  /**
   * The value scoring uses when the facts do not tell (else the feature is missing: no contribution). Stored
   * feature snapshots keep the missing value itself (`null`): missingness is information (BF-059).
   */
  readonly missingDefault?: number | boolean | string;
  readonly reasons: ReasonTexts;
}

/**
 * Version of the features' semantics: bump it when a compute function changes meaning (stored snapshots say which
 * version produced them, and a recompute is not skipped as "unchanged"). Feature keys are append-only: deprecate a
 * key, never remove or rename it (snapshots and profile versions refer to it forever).
 */
export const FEATURE_SET_VERSION = 1;

/** Pain tags that become `pain_share.<tag>` features (`other` says nothing an offer can address). */
export const SCORED_PAIN_TAGS = PAIN_SIGNAL_TAGS.filter(
  (tag): tag is Exclude<PainSignalTag, 'other'> => tag !== 'other',
);

const PAIN_LABELS: Record<(typeof SCORED_PAIN_TAGS)[number], Text> = {
  booking_friction: { en: 'booking friction', fr: 'des difficultés de réservation' },
  unreachable_by_phone: { en: 'being unreachable by phone', fr: 'l’impossibilité de joindre par téléphone' },
  slow_or_no_reply: { en: 'slow or missing replies', fr: 'des réponses lentes ou absentes' },
  website_broken_or_outdated: { en: 'a broken or outdated website', fr: 'un site cassé ou dépassé' },
  no_online_menu_or_prices: { en: 'no menu or prices online', fr: 'l’absence de carte ou de prix en ligne' },
  hard_to_find_info: { en: 'information that is hard to find', fr: 'des informations difficiles à trouver' },
  language_barrier: { en: 'a language barrier', fr: 'la barrière de la langue' },
  payment_friction: { en: 'payment friction', fr: 'des difficultés de paiement' },
  long_wait_times: { en: 'long wait times', fr: 'de longues attentes' },
  inconsistent_hours: { en: 'inconsistent opening hours', fr: 'des horaires incohérents' },
  poor_communication: { en: 'poor communication', fr: 'une mauvaise communication' },
  positive_strong_reputation: { en: 'a strong reputation', fr: 'une solide réputation' },
};

const PAIN_SHORT: Record<(typeof SCORED_PAIN_TAGS)[number], Text> = {
  booking_friction: { en: 'booking', fr: 'réservation' },
  unreachable_by_phone: { en: 'unreachable', fr: 'injoignable' },
  slow_or_no_reply: { en: 'slow replies', fr: 'réponses lentes' },
  website_broken_or_outdated: { en: 'website', fr: 'site' },
  no_online_menu_or_prices: { en: 'no menu or prices', fr: 'pas de carte ni de prix' },
  hard_to_find_info: { en: 'hard to find', fr: 'difficile à trouver' },
  language_barrier: { en: 'language', fr: 'langue' },
  payment_friction: { en: 'payment', fr: 'paiement' },
  long_wait_times: { en: 'waiting', fr: 'attente' },
  inconsistent_hours: { en: 'opening hours', fr: 'horaires' },
  poor_communication: { en: 'communication', fr: 'communication' },
  positive_strong_reputation: { en: 'praise', fr: 'éloges' },
};

const painFeatures = Object.fromEntries(
  SCORED_PAIN_TAGS.map((tag) => [
    `pain_share.${tag}`,
    {
      label: { en: `Reviews: ${PAIN_SHORT[tag].en}`, fr: `Avis : ${PAIN_SHORT[tag].fr}` },
      group: 'pain',
      type: 'number',
      unit: 'share',
      range: [0, 1],
      description: {
        en: `Share of analysed reviews mentioning ${PAIN_LABELS[tag].en} (0–1).`,
        fr: `Part des avis analysés qui évoquent ${PAIN_LABELS[tag].fr} (0–1).`,
      },
      source: 'review insights (BF-029)',
      reasons: {
        value: {
          en: `{value} of reviews mention ${PAIN_LABELS[tag].en}.`,
          fr: `{value} des avis évoquent ${PAIN_LABELS[tag].fr}.`,
        },
      },
    } satisfies FeatureDefinition,
  ]),
) as unknown as Record<`pain_share.${(typeof SCORED_PAIN_TAGS)[number]}`, FeatureDefinition>;

const yesNo = (yes: Text, no: Text): ReasonTexts => ({ true: yes, false: no });

const DEFINITIONS = {
  // Presence (website)
  has_website: {
    label: { en: 'Website', fr: 'Site web' },
    group: 'presence',
    type: 'boolean',
    unit: 'none',
    description: { en: 'The business has a website.', fr: 'L’entreprise a un site web.' },
    source: 'business record',
    reasons: yesNo(
      { en: 'Has a website address.', fr: 'A une adresse de site web.' },
      {
        en: 'No website: customers cannot find it online.',
        fr: 'Pas de site web : les clients ne la trouvent pas en ligne.',
      },
    ),
  },
  website_status: {
    label: { en: 'Website status', fr: 'Statut du site' },
    group: 'presence',
    type: 'enum',
    values: WEBSITE_STATUSES,
    unit: 'none',
    description: {
      en: 'Website status from the latest audit (none, parked, social only, broken, weak, ok, strong).',
      fr: 'Statut du site selon le dernier audit (aucun, parqué, réseaux sociaux seulement, cassé, faible, correct, solide).',
    },
    source: 'website audit (BF-030)',
    reasons: {
      none: { en: 'No website.', fr: 'Pas de site web.' },
      parked: { en: 'The domain is parked: no real site.', fr: 'Le domaine est parqué : pas de vrai site.' },
      social_only: {
        en: 'Only a social media page, no website.',
        fr: 'Seulement une page de réseau social, pas de site.',
      },
      broken: { en: 'The website is broken.', fr: 'Le site web est cassé.' },
      weak: { en: 'The website is weak.', fr: 'Le site web est faible.' },
      ok: { en: 'The audit flagged no major problem.', fr: 'L’audit n’a relevé aucun problème majeur.' },
      strong: { en: 'The website is already strong.', fr: 'Le site web est déjà solide.' },
    },
  },
  website_quality_score: {
    label: { en: 'Website quality', fr: 'Qualité du site' },
    group: 'presence',
    type: 'number',
    unit: 'score100',
    range: [0, 100],
    description: { en: 'Website quality score (0–100).', fr: 'Score de qualité du site (0–100).' },
    source: 'website audit (BF-030)',
    reasons: {
      value: { en: 'Website quality score {value}.', fr: 'Score de qualité du site : {value}.' },
    },
  },
  psi_mobile_performance: {
    label: { en: 'Mobile speed', fr: 'Vitesse mobile' },
    group: 'presence',
    type: 'number',
    unit: 'score100',
    range: [0, 100],
    description: {
      en: 'Google PageSpeed performance score on mobile (0–100).',
      fr: 'Score de performance PageSpeed de Google sur mobile (0–100).',
    },
    source: 'website audit (BF-030)',
    reasons: { value: { en: 'Mobile speed score {value}.', fr: 'Score de vitesse mobile : {value}.' } },
  },
  lcp_mobile_seconds: {
    label: { en: 'Mobile load time', fr: 'Temps de chargement mobile' },
    group: 'presence',
    type: 'number',
    unit: 'seconds',
    range: [0, 30],
    description: {
      en: 'Time until the main content shows on mobile (largest contentful paint, seconds).',
      fr: 'Temps d’affichage du contenu principal sur mobile (largest contentful paint, secondes).',
    },
    source: 'website audit (BF-030)',
    reasons: {
      value: {
        en: 'The page takes {value} to show on a phone.',
        fr: 'La page met {value} à s’afficher sur mobile.',
      },
    },
  },
  vision_overall: {
    label: { en: 'Design grade', fr: 'Note de design' },
    group: 'presence',
    type: 'number',
    unit: 'score10',
    range: [0, 10],
    description: { en: 'Visual design grade (0–10).', fr: 'Note de design visuel (0–10).' },
    source: 'website audit (BF-030)',
    reasons: { value: { en: 'The design is graded {value}.', fr: 'Le design est noté {value}.' } },
  },
  has_https: {
    label: { en: 'HTTPS', fr: 'HTTPS' },
    group: 'presence',
    type: 'boolean',
    unit: 'none',
    description: { en: 'The website is served over HTTPS.', fr: 'Le site est servi en HTTPS.' },
    source: 'website crawl (BF-026)',
    reasons: yesNo(
      { en: 'The site is secure (HTTPS).', fr: 'Le site est sécurisé (HTTPS).' },
      { en: 'The site is not secure (no HTTPS).', fr: 'Le site n’est pas sécurisé (pas de HTTPS).' },
    ),
  },
  site_freshness_years: {
    label: { en: 'Site age', fr: 'Ancienneté du site' },
    group: 'presence',
    type: 'number',
    unit: 'years',
    range: [0, 20],
    description: {
      en: 'Years since the site was last updated (copyright year, dated content, sitemap).',
      fr: 'Années depuis la dernière mise à jour du site (année du copyright, contenu daté, sitemap).',
    },
    source: 'website crawl (BF-026)',
    reasons: {
      value: { en: 'The site was last updated {value} ago.', fr: 'Le site a été mis à jour il y a {value}.' },
    },
  },
  has_booking_tool: {
    label: { en: 'Online booking', fr: 'Réservation en ligne' },
    group: 'presence',
    type: 'boolean',
    unit: 'none',
    description: { en: 'The website offers online booking.', fr: 'Le site propose la réservation en ligne.' },
    source: 'website crawl (BF-026)',
    reasons: {
      ...yesNo(
        { en: 'Already takes bookings online.', fr: 'Prend déjà des réservations en ligne.' },
        { en: 'No online booking.', fr: 'Pas de réservation en ligne.' },
      ),
      missing: { en: 'No online booking seen.', fr: 'Aucune réservation en ligne repérée.' },
    },
  },
  has_online_menu: {
    label: { en: 'Menu or prices online', fr: 'Carte ou tarifs en ligne' },
    group: 'presence',
    type: 'boolean',
    unit: 'none',
    description: {
      en: 'The website shows a menu or price list.',
      fr: 'Le site présente une carte ou des tarifs.',
    },
    source: 'website crawl (BF-026)',
    reasons: yesNo(
      { en: 'Menu or prices are online.', fr: 'La carte ou les tarifs sont en ligne.' },
      { en: 'No menu or prices online.', fr: 'Pas de carte ni de tarifs en ligne.' },
    ),
  },
  has_contact_form: {
    label: { en: 'Contact form', fr: 'Formulaire de contact' },
    group: 'presence',
    type: 'boolean',
    unit: 'none',
    description: { en: 'The website has a contact form.', fr: 'Le site a un formulaire de contact.' },
    source: 'website crawl (BF-026)',
    reasons: yesNo(
      { en: 'Has a contact form.', fr: 'A un formulaire de contact.' },
      { en: 'No contact form on the site.', fr: 'Pas de formulaire de contact sur le site.' },
    ),
  },
  has_language_gap_for_market: {
    label: { en: 'Missing language', fr: 'Langue manquante' },
    group: 'presence',
    type: 'boolean',
    unit: 'none',
    description: {
      en: 'The website misses a language its market expects (English for tourism, French in French-speaking areas).',
      fr: 'Il manque au site une langue attendue par son marché (anglais pour le tourisme, français en zone francophone).',
    },
    source: 'website audit (BF-030)',
    reasons: yesNo(
      {
        en: 'The site misses a language its customers speak.',
        fr: 'Il manque au site une langue de ses clients.',
      },
      { en: 'The site speaks its customers’ languages.', fr: 'Le site parle les langues de ses clients.' },
    ),
  },
  no_solicitation_notice: {
    label: { en: 'No-solicitation notice', fr: 'Refus du démarchage' },
    group: 'presence',
    type: 'boolean',
    unit: 'none',
    description: {
      en: 'The website asks not to be solicited.',
      fr: 'Le site demande à ne pas être démarché.',
    },
    source: 'website crawl (BF-026)',
    missingDefault: false,
    reasons: yesNo(
      { en: 'The site asks not to be solicited.', fr: 'Le site demande à ne pas être démarché.' },
      { en: 'No objection to solicitation found.', fr: 'Aucune opposition au démarchage relevée.' },
    ),
  },
  // Business
  category_offer_relevance: {
    label: { en: 'Offer fit', fr: 'Pertinence de l’offre' },
    group: 'business',
    type: 'number',
    unit: 'share',
    range: [0, 1],
    description: {
      en: 'How relevant the profile’s offer is to the business category (0–1).',
      fr: 'Pertinence de l’offre du profil pour la catégorie de l’entreprise (0–1).',
    },
    source: 'category taxonomy (BF-015)',
    // Relevance comes in tenths: 0.5 reads as the weaker side.
    pivot: 0.55,
    reasons: {
      below: {
        en: 'This offer is a weaker fit for this kind of business ({value} relevance).',
        fr: 'Cette offre convient moins à ce type d’entreprise (pertinence {value}).',
      },
      above: {
        en: 'This kind of business often needs this offer ({value} relevance).',
        fr: 'Ce type d’entreprise a souvent besoin de cette offre (pertinence {value}).',
      },
    },
  },
  appointment_based: {
    label: { en: 'By appointment', fr: 'Sur rendez-vous' },
    group: 'business',
    type: 'boolean',
    unit: 'none',
    description: { en: 'The business works by appointment.', fr: 'L’entreprise travaille sur rendez-vous.' },
    source: 'category taxonomy (BF-015)',
    missingDefault: false,
    reasons: yesNo(
      { en: 'Works by appointment.', fr: 'Travaille sur rendez-vous.' },
      { en: 'Does not work by appointment.', fr: 'Ne travaille pas sur rendez-vous.' },
    ),
  },
  tourism_facing: {
    label: { en: 'Tourism', fr: 'Tourisme' },
    group: 'business',
    type: 'boolean',
    unit: 'none',
    description: { en: 'The business serves tourists.', fr: 'L’entreprise accueille des touristes.' },
    source: 'category taxonomy (BF-015)',
    missingDefault: false,
    reasons: yesNo(
      { en: 'Serves tourists.', fr: 'Accueille des touristes.' },
      { en: 'Mostly local customers.', fr: 'Clientèle surtout locale.' },
    ),
  },
  price_level: {
    label: { en: 'Price level', fr: 'Niveau de prix' },
    group: 'business',
    type: 'number',
    unit: 'count',
    range: [1, 4],
    description: { en: 'Price level (1–4).', fr: 'Niveau de prix (1–4).' },
    source: 'business record',
    reasons: { value: { en: 'Price level {value} of 4.', fr: 'Niveau de prix {value} sur 4.' } },
  },
  rating_avg: {
    label: { en: 'Rating', fr: 'Note' },
    group: 'business',
    type: 'number',
    unit: 'rating',
    range: [1, 5],
    description: { en: 'Average customer rating (1–5).', fr: 'Note moyenne des clients (1–5).' },
    source: 'business record',
    reasons: { value: { en: 'Rated {value}.', fr: 'Noté {value}.' } },
  },
  review_count_log: {
    label: { en: 'Reviews', fr: 'Avis' },
    group: 'business',
    type: 'number',
    unit: 'log_count',
    range: [0, 4],
    description: {
      en: 'Number of reviews, on a log scale (log10 of 1 + count).',
      fr: 'Nombre d’avis, en échelle logarithmique (log10 de 1 + nombre).',
    },
    source: 'business record',
    reasons: { value: { en: 'Reviews: {value}.', fr: 'Avis : {value}.' } },
  },
  owner_response_rate: {
    label: { en: 'Owner replies', fr: 'Réponses du propriétaire' },
    group: 'business',
    type: 'number',
    unit: 'share',
    range: [0, 1],
    description: {
      en: 'Share of reviews the owner replied to (at least, 0–1).',
      fr: 'Part des avis auxquels le propriétaire a répondu (au moins, 0–1).',
    },
    source: 'review insights (BF-029)',
    reasons: {
      value: {
        en: 'The owner replies to {value} of reviews.',
        fr: 'Le propriétaire répond à {value} des avis.',
      },
    },
  },
  multi_location: {
    label: { en: 'Several locations', fr: 'Plusieurs établissements' },
    group: 'business',
    type: 'boolean',
    unit: 'none',
    description: {
      en: 'The business has several locations (one website shared by several businesses).',
      fr: 'L’entreprise a plusieurs établissements (un site partagé par plusieurs fiches).',
    },
    source: 'business graph',
    missingDefault: false,
    reasons: yesNo(
      { en: 'Has several locations.', fr: 'A plusieurs établissements.' },
      { en: 'A single location.', fr: 'Un seul établissement.' },
    ),
  },
  ad_pixels_present: {
    label: { en: 'Online ads', fr: 'Publicité en ligne' },
    group: 'business',
    type: 'boolean',
    unit: 'none',
    description: {
      en: 'The website carries advertising pixels (Meta, TikTok): the business pays for marketing.',
      fr: 'Le site porte des pixels publicitaires (Meta, TikTok) : l’entreprise investit dans le marketing.',
    },
    source: 'website crawl (BF-026)',
    reasons: yesNo(
      { en: 'Already pays for online advertising.', fr: 'Investit déjà dans la publicité en ligne.' },
      { en: 'No online advertising seen.', fr: 'Aucune publicité en ligne relevée.' },
    ),
  },
  operating_status: {
    label: { en: 'Open status', fr: 'Statut d’ouverture' },
    group: 'business',
    type: 'enum',
    values: OPERATING_STATUSES,
    unit: 'none',
    description: { en: 'Whether the business is open.', fr: 'Si l’entreprise est ouverte.' },
    source: 'business record',
    reasons: {
      operational: { en: 'Open for business.', fr: 'En activité.' },
      closed_temporarily: { en: 'Temporarily closed.', fr: 'Fermée temporairement.' },
      closed_permanently: { en: 'Permanently closed.', fr: 'Fermée définitivement.' },
      unknown: { en: 'Opening status unknown.', fr: 'Statut d’ouverture inconnu.' },
    },
  },
  // Pain (reviews)
  ...painFeatures,
  sentiment_avg: {
    label: { en: 'Review sentiment', fr: 'Sentiment des avis' },
    group: 'pain',
    type: 'number',
    unit: 'none',
    range: [-1, 1],
    description: { en: 'Average review sentiment (−1 to 1).', fr: 'Sentiment moyen des avis (−1 à 1).' },
    source: 'review insights (BF-029)',
    pivot: 0,
    reasons: {
      below: { en: 'Customers are unhappy in reviews.', fr: 'Les clients se plaignent dans les avis.' },
      above: { en: 'Customers are happy in reviews.', fr: 'Les clients sont satisfaits dans les avis.' },
    },
  },
  // Reachability
  has_verified_email: {
    label: { en: 'Verified e-mail', fr: 'E-mail vérifié' },
    group: 'reachability',
    type: 'boolean',
    unit: 'none',
    description: { en: 'A verified e-mail address is known.', fr: 'Une adresse e-mail vérifiée est connue.' },
    source: 'contacts (BF-028)',
    missingDefault: false,
    reasons: yesNo(
      { en: 'Reachable by a verified e-mail.', fr: 'Joignable par un e-mail vérifié.' },
      { en: 'No verified e-mail address.', fr: 'Aucune adresse e-mail vérifiée.' },
    ),
  },
  has_usable_email: {
    label: { en: 'Usable e-mail', fr: 'E-mail utilisable' },
    group: 'reachability',
    type: 'boolean',
    unit: 'none',
    description: {
      en: 'An e-mail address worth writing to is known (valid, accept-all or not yet verified).',
      fr: 'Une adresse e-mail utilisable est connue (valide, acceptant tout ou pas encore vérifiée).',
    },
    source: 'contacts (BF-028)',
    missingDefault: false,
    reasons: yesNo(
      { en: 'Reachable by e-mail.', fr: 'Joignable par e-mail.' },
      { en: 'No usable e-mail address.', fr: 'Aucune adresse e-mail utilisable.' },
    ),
  },
  has_generic_email_only: {
    label: { en: 'Generic e-mail only', fr: 'E-mail générique seulement' },
    group: 'reachability',
    type: 'boolean',
    unit: 'none',
    description: {
      en: 'The only usable e-mails are generic ones (info@, contact@); unknown without a usable e-mail.',
      fr: 'Les seuls e-mails utilisables sont génériques (info@, contact@) ; inconnu sans e-mail utilisable.',
    },
    source: 'contacts (BF-028)',
    reasons: yesNo(
      { en: 'Only a generic e-mail address.', fr: 'Seulement une adresse e-mail générique.' },
      { en: 'A personal e-mail address is known.', fr: 'Une adresse e-mail personnelle est connue.' },
    ),
  },
  has_phone: {
    label: { en: 'Phone', fr: 'Téléphone' },
    group: 'reachability',
    type: 'boolean',
    unit: 'none',
    description: { en: 'A phone number is known.', fr: 'Un numéro de téléphone est connu.' },
    source: 'contacts',
    missingDefault: false,
    reasons: yesNo(
      { en: 'Reachable by phone.', fr: 'Joignable par téléphone.' },
      { en: 'No phone number.', fr: 'Aucun numéro de téléphone.' },
    ),
  },
  has_whatsapp: {
    label: { en: 'WhatsApp', fr: 'WhatsApp' },
    group: 'reachability',
    type: 'boolean',
    unit: 'none',
    description: { en: 'A WhatsApp contact is known.', fr: 'Un contact WhatsApp est connu.' },
    source: 'contacts',
    missingDefault: false,
    reasons: yesNo(
      { en: 'Reachable on WhatsApp.', fr: 'Joignable sur WhatsApp.' },
      { en: 'No WhatsApp contact.', fr: 'Aucun contact WhatsApp.' },
    ),
  },
  // Workspace
  do_not_contact: {
    label: { en: 'Do not contact', fr: 'Ne pas contacter' },
    group: 'workspace',
    type: 'boolean',
    unit: 'none',
    description: {
      en: 'The workspace marked it do-not-contact.',
      fr: 'L’espace de travail l’a marquée à ne pas contacter.',
    },
    source: 'CRM (BF-024)',
    missingDefault: false,
    reasons: yesNo(
      { en: 'Marked do-not-contact.', fr: 'Marquée à ne pas contacter.' },
      { en: 'May be contacted.', fr: 'Peut être contactée.' },
    ),
  },
  pipeline_status: {
    label: { en: 'Pipeline stage', fr: 'Étape du pipeline' },
    group: 'workspace',
    type: 'enum',
    values: PIPELINE_STATUSES,
    unit: 'none',
    description: {
      en: 'Where the business stands in the pipeline.',
      fr: 'Où en est l’entreprise dans le pipeline.',
    },
    source: 'CRM (BF-024)',
    reasons: {
      disqualified: { en: 'Disqualified in the pipeline.', fr: 'Disqualifiée dans le pipeline.' },
      won: { en: 'Already a customer.', fr: 'Déjà cliente.' },
      lost: { en: 'Lost earlier.', fr: 'Perdue précédemment.' },
    },
  },
  days_since_last_contact: {
    label: { en: 'Last contact', fr: 'Dernier contact' },
    group: 'workspace',
    type: 'number',
    unit: 'days',
    range: [0, 3650],
    description: {
      en: 'Days since the workspace last contacted the business (none if never).',
      fr: 'Jours depuis le dernier contact de l’espace de travail (aucun si jamais).',
    },
    source: 'CRM (BF-024)',
    reasons: { value: { en: 'Last contacted {value} ago.', fr: 'Dernier contact il y a {value}.' } },
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof DEFINITIONS;
/** The feature registry (stable keys: profiles and stored feature snapshots refer to them). */
export const FEATURE_DEFINITIONS: Readonly<Record<FeatureKey, FeatureDefinition>> = DEFINITIONS;
export const FEATURE_KEYS = Object.keys(DEFINITIONS) as [FeatureKey, ...FeatureKey[]];
export const FeatureKeySchema = z.enum(FEATURE_KEYS);

export type FeatureValue = number | boolean | string | null;
export const FeatureValueSchema = z.union([z.number(), z.boolean(), z.string(), z.null()]);
/** A business's feature vector at a point in time (stored with each score for BF-059). */
export const FeatureVectorSchema = z.partialRecord(FeatureKeySchema, FeatureValueSchema);
export type FeatureVector = z.infer<typeof FeatureVectorSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Profiles

const unit = z.number().min(0).max(1);
const finite = z.number().finite();

/** Maps a raw value to 0–1 (Strategy). Values outside a range are clamped. */
export const TransformSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('linear'), min: finite, max: finite }),
    /** 1 − linear: less is better (load time, quality of the current site…). */
    z.object({ kind: z.literal('inverse'), min: finite, max: finite }),
    z.object({
      kind: z.literal('piecewise'),
      /**
       * `[x, y]` points, x strictly increasing and y never decreasing (every transform is monotone; for "less is
       * better", give the feature a negative weight); linear in between, flat outside.
       */
      points: z
        .array(z.tuple([finite, unit]))
        .min(2)
        .max(20),
    }),
    /** log(1 + x) / log(1 + max), clamped (DECISION: no `base` — the ratio is the same in every base). */
    z.object({ kind: z.literal('log'), max: z.number().positive() }),
    z.object({ kind: z.literal('boolean'), true: unit, false: unit }),
    z.object({
      kind: z.literal('enumMap'),
      map: z
        .record(z.string().max(60), unit)
        .refine((map) => Object.keys(map).length <= 50, { message: 'At most 50 values' }),
      default: unit.default(0),
    }),
  ])
  .superRefine((transform, ctx) => {
    if ((transform.kind === 'linear' || transform.kind === 'inverse') && transform.max <= transform.min) {
      ctx.addIssue({ code: 'custom', message: '`max` must be greater than `min`' });
    }
    if (
      transform.kind === 'piecewise' &&
      transform.points.some((point, i) => i > 0 && point[0] <= (transform.points[i - 1]?.[0] ?? -Infinity))
    ) {
      ctx.addIssue({ code: 'custom', message: 'piecewise points must have strictly increasing x' });
    }
    if (
      transform.kind === 'piecewise' &&
      transform.points.some((point, i) => i > 0 && point[1] < (transform.points[i - 1]?.[1] ?? -Infinity))
    ) {
      ctx.addIssue({ code: 'custom', message: 'piecewise points must not decrease' });
    }
  })
  .meta({ id: 'ScoringTransform' });
export type Transform = z.infer<typeof TransformSchema>;

/** A condition on the feature vector (Specification): one operator per leaf, combined with all/any/not. */
export type GateCondition =
  | {
      readonly feature: FeatureKey;
      readonly eq?: number | boolean | string | undefined;
      readonly neq?: number | boolean | string | undefined;
      readonly in?: readonly (number | boolean | string)[] | undefined;
      readonly gt?: number | undefined;
      readonly gte?: number | undefined;
      readonly lt?: number | undefined;
      readonly lte?: number | undefined;
      readonly isNull?: boolean | undefined;
    }
  | { readonly all: readonly GateCondition[] }
  | { readonly any: readonly GateCondition[] }
  | { readonly not: GateCondition };

const LEAF_OPERATORS = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'isNull'] as const;
const scalar = z.union([z.number(), z.boolean(), z.string().max(100)]);
export const GateConditionSchema: z.ZodType<GateCondition> = z
  .lazy(() =>
    z.union([
      z
        .object({
          feature: FeatureKeySchema,
          eq: scalar.optional(),
          neq: scalar.optional(),
          in: z.array(scalar).min(1).max(50).optional(),
          gt: finite.optional(),
          gte: finite.optional(),
          lt: finite.optional(),
          lte: finite.optional(),
          isNull: z.boolean().optional(),
        })
        .strict()
        .refine((leaf) => LEAF_OPERATORS.filter((op) => leaf[op] !== undefined).length === 1, {
          message: 'A condition needs exactly one operator',
        }),
      z.object({ all: z.array(GateConditionSchema).min(1).max(20) }).strict(),
      z.object({ any: z.array(GateConditionSchema).min(1).max(20) }).strict(),
      z.object({ not: GateConditionSchema }).strict(),
    ]),
  )
  .meta({ id: 'ScoringGateCondition' });

const TextSchema = z.object({ en: z.string().min(1).max(300), fr: z.string().min(1).max(300) });

/** Bounds of a gate condition (the recursive schema would overflow the stack on a deeply nested input). */
export const GATE_CONDITION_LIMITS = { depth: 6, nodes: 100 } as const;

/** Depth and size of a raw condition, measured without recursion; null when within the limits. */
function conditionTooLarge(raw: unknown): string | null {
  const stack: [unknown, number][] = [[raw, 1]];
  let nodes = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    nodes += 1;
    if (depth > GATE_CONDITION_LIMITS.depth)
      return `Conditions nest at most ${GATE_CONDITION_LIMITS.depth} levels`;
    if (nodes > GATE_CONDITION_LIMITS.nodes)
      return `A gate has at most ${GATE_CONDITION_LIMITS.nodes} conditions`;
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    for (const key of ['all', 'any'] as const) {
      const parts = record[key];
      if (Array.isArray(parts)) for (const part of parts) stack.push([part, depth + 1]);
    }
    if ('not' in record) stack.push([record.not, depth + 1]);
  }
  return null;
}

/** A gate condition from a request: size-checked before the recursive schema reads it. */
const BoundedGateConditionSchema = z
  .unknown()
  .superRefine((raw, ctx) => {
    const problem = conditionTooLarge(raw);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  })
  .pipe(GateConditionSchema)
  .meta({
    description: `A ScoringGateCondition (leaf, all, any, not): at most ${GATE_CONDITION_LIMITS.depth} levels and ${GATE_CONDITION_LIMITS.nodes} conditions.`,
  });

export const GateSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    when: BoundedGateConditionSchema,
    /** `exclude`: tier X, score 0; `cap`: the score is at most `max`. An exclusion wins over caps. */
    effect: z.discriminatedUnion('type', [
      z.object({ type: z.literal('exclude') }),
      z.object({ type: z.literal('cap'), max: z.number().int().min(0).max(100) }),
    ]),
    reason: TextSchema,
  })
  .meta({ id: 'ScoringGate' });
export type Gate = z.infer<typeof GateSchema>;

export const ReasonTextsSchema = z.partialRecord(z.string().max(40), TextSchema);

/** The engine's own gate id (do-not-contact always excludes): a profile cannot reuse it. */
export const DO_NOT_CONTACT_GATE_ID = 'do_not_contact';

const ProfileConfigObjectSchema = z.object({
  /** Rule-based (this config); model-based profiles (BF-059) will be another kind. */
  kind: z.literal('rules').default('rules'),
  offer: OfferSchema,
  /** Feature → weight (negative weights lower the score). */
  weights: z.partialRecord(FeatureKeySchema, z.number().min(-100).max(100)),
  transforms: z.partialRecord(FeatureKeySchema, TransformSchema).default({}),
  /**
   * The transformed value (0–1) of a feature when it is missing, for this profile (e.g. booking counts an unknown
   * booking tool as none). Without it, a missing feature contributes nothing.
   */
  missing: z.partialRecord(FeatureKeySchema, unit).default({}),
  gates: z.array(GateSchema).max(30).default([]),
  /** Tier A from `A`, B from `B`, else C (gated out: X). */
  tiers: z
    .object({ A: z.number().int().min(1).max(100), B: z.number().int().min(0).max(99) })
    .refine((tiers) => tiers.A > tiers.B, { message: 'Tier A must start above tier B' }),
  /**
   * `weighted_sum`: 100 × Σ weight × transformed ÷ Σ positive weights, clamped to 0–100. A missing feature
   * contributes nothing (or its `missing` value), but its weight still counts.
   */
  normalization: z.literal('weighted_sum').default('weighted_sum'),
  /** Overrides of the registry's reason texts, per feature. */
  reasonTemplates: z.partialRecord(FeatureKeySchema, ReasonTextsSchema).default({}),
});

export type ProblemPath = readonly (string | number)[];
export interface ProfileProblem {
  /** Path in the config (`['transforms', 'pain_share.booking_friction']`, `['gates', 0, 'when', 'any', 1]`). */
  readonly path: ProblemPath;
  readonly message: string;
}
export const ProfileProblemSchema = z
  .object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })
  .meta({ id: 'ScoringProfileProblem' });

/** The transforms that fit a feature's type (the editor offers these). */
export const TRANSFORM_KINDS_FOR: Readonly<Record<FeatureDefinition['type'], readonly Transform['kind'][]>> =
  {
    number: ['linear', 'inverse', 'piecewise', 'log'],
    boolean: ['boolean'],
    enum: ['enumMap'],
  };

function conditionProblems(condition: GateCondition, path: ProblemPath, problems: ProfileProblem[]): void {
  if ('all' in condition) {
    for (const [i, part] of condition.all.entries()) conditionProblems(part, [...path, 'all', i], problems);
    return;
  }
  if ('any' in condition) {
    for (const [i, part] of condition.any.entries()) conditionProblems(part, [...path, 'any', i], problems);
    return;
  }
  if ('not' in condition) {
    conditionProblems(condition.not, [...path, 'not'], problems);
    return;
  }
  const definition = FEATURE_DEFINITIONS[condition.feature];
  const values = [condition.eq, condition.neq, ...(condition.in ?? [])].filter(
    (value) => value !== undefined,
  );
  for (const value of values) {
    const fits =
      definition.type === 'enum'
        ? typeof value === 'string' && (definition.values ?? []).includes(value)
        : typeof value === (definition.type === 'number' ? 'number' : 'boolean');
    if (!fits) problems.push({ path, message: `${String(value)} is not a value of ${condition.feature}` });
  }
  const ordered = [condition.gt, condition.gte, condition.lt, condition.lte].some(
    (value) => value !== undefined,
  );
  if (ordered && definition.type !== 'number') {
    problems.push({ path, message: `${condition.feature} is not a number: it cannot be compared` });
  }
  if (condition.isNull !== undefined && definition.missingDefault !== undefined) {
    problems.push({ path, message: `${condition.feature} is never missing (it has a default)` });
  }
}

/**
 * What the schema's shapes cannot say (BF-031), shared by the API and the profile editor (BF-032): a transform must
 * fit its feature's type, an enum needs an `enumMap`, a number off the 0–1 scale needs a transform, a `missing`
 * value needs a feature that can be missing, gate values and reason keys must exist, gate ids must be unique (and
 * not the engine's own). Empty when the profile is usable.
 */
export function profileProblems(config: z.output<typeof ProfileConfigObjectSchema>): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  if (!Object.values(config.weights).some((weight) => (weight ?? 0) > 0)) {
    problems.push({ path: ['weights'], message: 'At least one feature needs a positive weight' });
  }
  for (const [key, weight] of Object.entries(config.weights) as [FeatureKey, number][]) {
    if (weight === 0) continue;
    const definition = FEATURE_DEFINITIONS[key];
    const transform = config.transforms[key];
    if (transform && !TRANSFORM_KINDS_FOR[definition.type].includes(transform.kind)) {
      problems.push({
        path: ['transforms', key],
        message: `A ${definition.type} feature cannot use ${transform.kind}`,
      });
    }
    if (!transform && definition.type === 'enum') {
      problems.push({ path: ['transforms', key], message: 'An enum feature needs an enumMap transform' });
    }
    if (!transform && definition.type === 'number' && definition.unit !== 'share') {
      problems.push({
        path: ['transforms', key],
        message: 'This number is not on 0–1: it needs a transform',
      });
    }
    if (transform?.kind === 'enumMap') {
      for (const value of Object.keys(transform.map)) {
        if (!(definition.values ?? []).includes(value)) {
          problems.push({
            path: ['transforms', key, 'map', value],
            message: `${value} is not a value of ${key}`,
          });
        }
      }
    }
  }
  for (const section of ['transforms', 'missing'] as const) {
    for (const key of Object.keys(config[section]) as FeatureKey[]) {
      if (config.weights[key] === undefined) {
        problems.push({ path: [section, key], message: 'Set for a feature without a weight' });
      }
    }
  }
  for (const key of Object.keys(config.missing) as FeatureKey[]) {
    if (FEATURE_DEFINITIONS[key].missingDefault !== undefined) {
      problems.push({ path: ['missing', key], message: `${key} is never missing (it has a default)` });
    }
  }
  for (const [key, texts] of Object.entries(config.reasonTemplates) as [
    FeatureKey,
    Readonly<Partial<Record<string, Text>>>,
  ][]) {
    const definition = FEATURE_DEFINITIONS[key];
    const allowed = new Set([
      'value',
      'missing',
      ...(definition.type === 'boolean' ? ['true', 'false'] : []),
      ...(definition.type === 'enum' ? (definition.values ?? []) : []),
      ...(definition.pivot !== undefined ? ['below', 'above'] : []),
    ]);
    for (const value of Object.keys(texts)) {
      if (value === 'missing' && config.missing[key] === undefined) {
        problems.push({
          path: ['reasonTemplates', key, value],
          message: 'Read only for a value this profile fills in',
        });
        continue;
      }
      if (!allowed.has(value)) {
        problems.push({
          path: ['reasonTemplates', key, value],
          message: `${value} is not a value of ${key}`,
        });
      }
      for (const locale of ['en', 'fr'] as const) {
        const unknown = unknownPlaceholders(texts[value]?.[locale] ?? '');
        if (unknown.length > 0) {
          problems.push({
            path: ['reasonTemplates', key, value, locale],
            message: `Unknown placeholder ${unknown.join(', ')} (only {value})`,
          });
        }
      }
    }
  }
  const ids = new Set<string>([DO_NOT_CONTACT_GATE_ID]);
  for (const [i, gate] of config.gates.entries()) {
    if (ids.has(gate.id)) {
      problems.push({ path: ['gates', i, 'id'], message: `Gate id ${gate.id} is reserved or used twice` });
    }
    ids.add(gate.id);
    conditionProblems(gate.when, ['gates', i, 'when'], problems);
  }
  return problems;
}

/** The placeholders a reason template may use. */
export const REASON_PLACEHOLDERS = ['{value}'] as const;

/** Placeholders of a reason template other than `{value}` (a typo would be shown to the user as is). */
export function unknownPlaceholders(template: string): string[] {
  const found = template.match(/\{[^{}]*\}/g) ?? [];
  return [...new Set(found.filter((token) => !(REASON_PLACEHOLDERS as readonly string[]).includes(token)))];
}

/** A usable profile config: the shapes, then `profileProblems` (each problem an issue at its path). */
export const ScoringProfileConfigSchema = ProfileConfigObjectSchema.superRefine((config, ctx) => {
  for (const problem of profileProblems(config)) {
    ctx.addIssue({ code: 'custom', path: [...problem.path], message: problem.message });
  }
}).meta({ id: 'ScoringProfileConfig' });
export type ScoringProfileConfig = z.infer<typeof ScoringProfileConfigSchema>;
export type ScoringProfileConfigInput = z.input<typeof ScoringProfileConfigSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Scores

export const ScoreContributionSchema = z
  .object({
    feature: FeatureKeySchema,
    /** The value scored: the snapshot's, or the registry default that stood in for a missing one. */
    rawValue: FeatureValueSchema,
    /** 0–1 after the transform (or the profile's `missing` value); null when nothing stood in. */
    transformed: z.number().min(0).max(1).nullable(),
    /** What stood in for a missing value: the registry default, the profile's `missing` value, or nothing. */
    imputed: z.enum(['default', 'profile']).nullable(),
    weight: z.number(),
    /** Score points (signed). */
    contribution: z.number(),
  })
  .meta({ id: 'ScoreContribution' });
export type ScoreContribution = z.infer<typeof ScoreContributionSchema>;

export const ScoreReasonSchema = z
  .object({
    feature: FeatureKeySchema,
    direction: z.enum(['positive', 'negative']),
    contribution: z.number(),
    text: TextSchema,
  })
  .meta({ id: 'ScoreReason' });
export type ScoreReason = z.infer<typeof ScoreReasonSchema>;

export const ScoreResultSchema = z
  .object({
    score: z.number().int().min(0).max(100),
    tier: ScoreTierSchema,
    contributions: z.array(ScoreContributionSchema),
    /** Top 3 reasons each way, strongest first. */
    reasons: z.array(ScoreReasonSchema),
    /**
     * The gate that decides (exclusion, or the lowest matching cap). `applied: false`: a cap matched but did not
     * lower the score — its reason still explains it (e.g. "no real website to redesign").
     */
    gated: z
      .object({
        gate: z.string(),
        effect: z.enum(['exclude', 'cap']),
        applied: z.boolean(),
        reason: TextSchema,
      })
      .nullable(),
  })
  .meta({ id: 'ScoreResult' });
export type ScoreResult = z.infer<typeof ScoreResultSchema>;

/** A business's score for one profile version (with the feature snapshot it was computed from). */
export const BusinessScoreSchema = ScoreResultSchema.extend({
  businessId: z.uuid(),
  profileId: z.uuid(),
  profileVersion: z.number().int().positive(),
  featureSetVersion: z.number().int().positive(),
  offer: OfferSchema,
  features: FeatureVectorSchema,
  computedAt: IsoDateTimeSchema,
}).meta({ id: 'BusinessScore' });
export type BusinessScore = z.infer<typeof BusinessScoreSchema>;

// ---------------------------------------------------------------------------------------------------------------
// API, events and jobs (BF-031 part 2)

export const ScoringProfileSummarySchema = z
  .object({
    id: z.uuid(),
    offer: OfferSchema,
    name: z.string(),
    builtin: z.boolean(),
    activeVersion: z.number().int().positive().nullable(),
    /** The workspace's primary profile (its score and tier fill the listing). */
    primary: z.boolean(),
    /** Archived workspace profiles are kept (their history) but no longer scored. */
    archived: z.boolean(),
  })
  .meta({ id: 'ScoringProfileSummary' });
export type ScoringProfileSummary = z.infer<typeof ScoringProfileSummarySchema>;
export const ScoringProfileListSchema = z
  .object({ items: z.array(ScoringProfileSummarySchema) })
  .meta({ id: 'ScoringProfileList' });
export type ScoringProfileList = z.infer<typeof ScoringProfileListSchema>;

export const ScoringProfileVersionSchema = z
  .object({
    profileId: z.uuid(),
    version: z.number().int().positive(),
    config: ScoringProfileConfigSchema,
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'ScoringProfileVersion' });
export type ScoringProfileVersion = z.infer<typeof ScoringProfileVersionSchema>;

export const BusinessScoreListSchema = z.object({ items: z.array(BusinessScoreSchema) }).meta({
  id: 'BusinessScoreList',
  description: "The business's current score per profile of the workspace.",
});
export type BusinessScoreList = z.infer<typeof BusinessScoreListSchema>;

/** Score a business with a draft config, nothing stored (the profile editor's preview, BF-032). */
export const ScoringExplainRequestSchema = z
  .object({ businessId: z.uuid(), config: ScoringProfileConfigSchema })
  .meta({ id: 'ScoringExplainRequest' });
export type ScoringExplainRequest = z.infer<typeof ScoringExplainRequestSchema>;
export const ScoringExplainResponseSchema = ScoreResultSchema.extend({
  features: FeatureVectorSchema,
  featureSetVersion: z.number().int().positive(),
}).meta({ id: 'ScoringExplainResponse' });
export type ScoringExplainResponse = z.infer<typeof ScoringExplainResponseSchema>;

export const ScoringRecomputeResponseSchema = z
  .object({
    profileId: z.uuid(),
    version: z.number().int().positive(),
    /** Tracked businesses to score (progress arrives as `scoring.recompute.progressed`). */
    total: z.number().int().nonnegative(),
  })
  .meta({ id: 'ScoringRecomputeResponse' });
export type ScoringRecomputeResponse = z.infer<typeof ScoringRecomputeResponseSchema>;

const ProfileNameSchema = z.string().trim().min(1).max(80);

/** A workspace profile, started from a profile it sees (built-in or its own): its active config becomes v1. */
export const CreateScoringProfileRequestSchema = z
  .object({ fromProfileId: z.uuid(), name: ProfileNameSchema })
  .meta({ id: 'CreateScoringProfileRequest' });
export type CreateScoringProfileRequest = z.infer<typeof CreateScoringProfileRequestSchema>;

export const UpdateScoringProfileRequestSchema = z
  .object({ name: ProfileNameSchema, archived: z.boolean() })
  .partial()
  .refine((body) => body.name !== undefined || body.archived !== undefined, { message: 'Nothing to change' })
  .meta({ id: 'UpdateScoringProfileRequest' });
export type UpdateScoringProfileRequest = z.infer<typeof UpdateScoringProfileRequestSchema>;

/** A new (inactive) version of a workspace profile. */
export const CreateScoringProfileVersionRequestSchema = z
  .object({ config: ScoringProfileConfigSchema })
  .meta({ id: 'CreateScoringProfileVersionRequest' });
export type CreateScoringProfileVersionRequest = z.infer<typeof CreateScoringProfileVersionRequestSchema>;

export const ActivateScoringProfileVersionRequestSchema = z
  .object({ version: z.number().int().positive().max(2_147_483_647) })
  .meta({ id: 'ActivateScoringProfileVersionRequest' });
export type ActivateScoringProfileVersionRequest = z.infer<typeof ActivateScoringProfileVersionRequestSchema>;

export const ScoringVersionCreatedSchema = z
  .object({ version: z.number().int().positive() })
  .meta({ id: 'ScoringVersionCreated' });
export type ScoringVersionCreated = z.infer<typeof ScoringVersionCreatedSchema>;

export const ScoringProfileVersionListSchema = z
  .object({
    items: z.array(
      z.object({ version: z.number().int().positive(), active: z.boolean(), createdAt: IsoDateTimeSchema }),
    ),
  })
  .meta({ id: 'ScoringProfileVersionList' });
export type ScoringProfileVersionList = z.infer<typeof ScoringProfileVersionListSchema>;

/** Up to 50 tracked businesses scored with a draft config, nothing stored (the editor's preview, in batches). */
export const SCORING_EXPLAIN_BATCH_MAX = 50;
export const ScoringExplainBatchRequestSchema = z
  .object({
    config: ScoringProfileConfigSchema,
    businessIds: z.array(z.uuid()).min(1).max(SCORING_EXPLAIN_BATCH_MAX),
  })
  .meta({ id: 'ScoringExplainBatchRequest' });
export type ScoringExplainBatchRequest = z.infer<typeof ScoringExplainBatchRequestSchema>;
export const ScoringExplainBatchResponseSchema = z
  .object({
    /** Businesses the workspace does not track are left out. */
    items: z.array(
      z.object({
        businessId: z.uuid(),
        score: z.number().int().min(0).max(100),
        tier: ScoreTierSchema,
        gate: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'ScoringExplainBatchResponse' });
export type ScoringExplainBatchResponse = z.infer<typeof ScoringExplainBatchResponseSchema>;

/** A sample of the workspace's businesses for the preview, stratified by their current tier for a profile. */
export const SCORING_PREVIEW_SAMPLE_MAX = 200;
export const ScoringPreviewSampleQuerySchema = z.object({
  profileId: z.uuid(),
  size: z.coerce.number().int().min(1).max(SCORING_PREVIEW_SAMPLE_MAX).default(SCORING_PREVIEW_SAMPLE_MAX),
});
export type ScoringPreviewSampleQuery = z.infer<typeof ScoringPreviewSampleQuerySchema>;
export const ScoringPreviewSampleSchema = z
  .object({
    items: z.array(
      z.object({
        businessId: z.uuid(),
        displayName: z.string(),
        score: z.number().int().min(0).max(100).nullable(),
        tier: ScoreTierSchema.nullable(),
      }),
    ),
  })
  .meta({ id: 'ScoringPreviewSample' });
export type ScoringPreviewSample = z.infer<typeof ScoringPreviewSampleSchema>;

export const SetPrimaryScoringProfileRequestSchema = z
  .object({ profileId: z.uuid() })
  .meta({ id: 'SetPrimaryScoringProfileRequest' });
export type SetPrimaryScoringProfileRequest = z.infer<typeof SetPrimaryScoringProfileRequestSchema>;

/** A business's score changed for a workspace profile (realtime, activity timeline, analytics). */
export const ScoreUpdated = defineEvent(
  'score.updated',
  1,
  z.object({
    businessId: BusinessId,
    profileId: z.uuid(),
    profileVersion: z.number().int().positive(),
    offer: OfferSchema,
    score: z.number().int().min(0).max(100),
    tier: ScoreTierSchema,
    previousScore: z.number().int().min(0).max(100).nullable(),
    previousTier: ScoreTierSchema.nullable(),
    /** The workspace's primary profile (its tier is the business's tier in the listing). */
    primary: z.boolean(),
  }),
);

/**
 * A profile version became active: a new built-in version at boot (no workspace: every workspace recomputes) or a
 * workspace's own profile (that workspace recomputes).
 */
export const ScoringProfileVersionActivated = defineEvent(
  'scoring.profile_version.activated',
  1,
  z.object({ profileId: z.uuid(), version: z.number().int().positive() }),
);

/** Realtime: a business's scores were written (its page and the listing refetch). Not sent during bulk recomputes. */
export const SCORING_SCORES_UPDATED = 'scoring.scores.updated';
/** Realtime: bulk recompute progress (≤ 1/s per profile, and once when it ends). */
export const SCORING_RECOMPUTE_PROGRESSED = 'scoring.recompute.progressed';
export const ScoringRecomputeProgressSchema = z.object({
  profileId: z.uuid(),
  version: z.number().int().positive(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  finished: z.boolean(),
});
export type ScoringRecomputeProgress = z.infer<typeof ScoringRecomputeProgressSchema>;

/** Scores businesses of a workspace with its active profiles (or the given ones). */
export const ScoringComputeJob = defineJob('scoring', 'compute', {
  businessIds: z.array(z.uuid()).min(1).max(1_000),
  profileIds: z.array(z.uuid()).max(50).optional(),
});
/** Scores every tracked business of a workspace with one profile version, in pages, with progress. */
export const ScoringRecomputeJob = defineJob('scoring-recompute', 'recompute', {
  profileId: z.uuid(),
  version: z.number().int().positive(),
});
