import { z } from 'zod';
import { type Offer, OfferSchema } from './taxonomy.ts';
import { IsoDateTimeSchema } from './time.ts';

// Website audit (BF-030): "is this website weak?", answered in an explainable way. PageSpeed Insights measures,
// a vision model grades screenshots against an anchored rubric, and deterministic rules turn the facts into
// prioritized findings, a 0–100 quality score and a website status used by search, scoring and outreach.

// ---------------------------------------------------------------------------------------------------------------
// PageSpeed Insights (compact: never the full Lighthouse report)

export const PSI_STRATEGIES = ['mobile', 'desktop'] as const;
export type PsiStrategy = (typeof PSI_STRATEGIES)[number];

const score = z.number().int().min(0).max(100).nullable();
const ms = z.number().min(0).nullable();

export const PsiStrategyResultSchema = z
  .object({
    scores: z.object({
      performance: score,
      accessibility: score,
      bestPractices: score,
      seo: score,
    }),
    /** Lab metrics (Lighthouse) and, when Chrome has field data, the page's 75th percentile. */
    metrics: z.object({
      lcpMs: ms,
      cls: z.number().min(0).nullable(),
      tbtMs: ms,
      fcpMs: ms,
      speedIndexMs: ms,
      ttfbMs: ms,
      /** Field data only (lab runs cannot measure interactions). */
      inpMs: ms,
    }),
    opportunities: z
      .array(
        z.object({
          id: z.string().max(100),
          title: z.string().max(200),
          savingsMs: z.number().min(0).nullable(),
          savingsBytes: z.number().min(0).nullable(),
        }),
      )
      .max(5),
    lighthouseVersion: z.string().max(30).nullable(),
    fetchedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'PsiStrategyResult' });
export type PsiStrategyResult = z.infer<typeof PsiStrategyResultSchema>;

export const PsiResultSchema = z
  .object({ mobile: PsiStrategyResultSchema.nullable(), desktop: PsiStrategyResultSchema.nullable() })
  .meta({ id: 'PsiResult' });
export type PsiResult = z.infer<typeof PsiResultSchema>;

/** Core Web Vitals and Lighthouse thresholds (web.dev): ≤ good is good, > poor is poor, in between needs work. */
export const METRIC_THRESHOLDS = {
  lcpMs: { good: 2_500, poor: 4_000 },
  cls: { good: 0.1, poor: 0.25 },
  inpMs: { good: 200, poor: 500 },
  tbtMs: { good: 200, poor: 600 },
  fcpMs: { good: 1_800, poor: 3_000 },
  speedIndexMs: { good: 3_400, poor: 5_800 },
  ttfbMs: { good: 800, poor: 1_800 },
} as const;
export type MetricName = keyof typeof METRIC_THRESHOLDS;

export function metricRating(metric: MetricName, value: number): 'good' | 'needs_improvement' | 'poor' {
  const { good, poor } = METRIC_THRESHOLDS[metric];
  return value <= good ? 'good' : value > poor ? 'poor' : 'needs_improvement';
}

// ---------------------------------------------------------------------------------------------------------------
// Vision grade

export const VISION_CRITERIA = [
  'modernity',
  'visual_hierarchy',
  'mobile_usability',
  'readability',
  'imagery_quality',
  'trust_signals',
  'cta_clarity',
  'brand_consistency',
] as const;
export const VisionCriterionSchema = z.enum(VISION_CRITERIA);
export type VisionCriterion = z.infer<typeof VisionCriterionSchema>;

/**
 * The vision grade. Its `summary` and criteria `evidence` are model output that screenshot content can influence:
 * untrusted text. Briefs and outreach never quote it, or wrap it as untrusted data (ai-engineering.md).
 */
export const VisionGradeSchema = z
  .object({
    criteria: z.record(
      VisionCriterionSchema,
      z.object({
        score: z.number().int().min(1).max(10),
        evidence: z
          .string()
          .max(300)
          .describe('What is visible in the screenshots that justifies the score.'),
      }),
    ),
    overall: z.number().int().min(1).max(10),
    summary: z.object({ en: z.string().max(600), fr: z.string().max(600) }),
    model: z.string(),
    promptVersion: z.number().int(),
    gradedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'VisionGrade' });
export type VisionGrade = z.infer<typeof VisionGradeSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Findings

export const FINDING_SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FINDING_CATEGORIES = [
  'presence',
  'security',
  'mobile',
  'performance',
  'conversion',
  'freshness',
  'accessibility',
  'seo',
  'design',
  'compliance',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

type Text = { readonly en: string; readonly fr: string };

export interface FindingDefinition {
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
  readonly title: Text;
  readonly explanation: Text;
  readonly recommendation: Text;
  /** Offers that address it, most relevant first. */
  readonly offers: readonly Offer[];
}

/** The findings registry (texts EN/FR); the rules that raise them live in the API (pure, unit-tested). */
export const FINDING_DEFINITIONS = {
  parked_domain: {
    category: 'presence',
    severity: 'critical',
    title: { en: 'Parked domain', fr: 'Domaine parqué' },
    explanation: {
      en: 'The address shows a parking or for-sale page instead of the business.',
      fr: 'L’adresse affiche une page de parking ou de vente au lieu de l’établissement.',
    },
    recommendation: {
      en: 'Publish a real website on the domain.',
      fr: 'Publier un vrai site sur ce domaine.',
    },
    offers: ['new_website'],
  },
  social_only: {
    category: 'presence',
    severity: 'major',
    title: { en: 'Social profile instead of a website', fr: 'Réseau social au lieu d’un site' },
    explanation: {
      en: 'The business links to a social profile or a link page, which it does not own or control.',
      fr: 'L’établissement renvoie vers un profil social ou une page de liens, qu’il ne maîtrise pas.',
    },
    recommendation: {
      en: 'Create an own website that the social profiles point to.',
      fr: 'Créer un site propre vers lequel pointent les réseaux sociaux.',
    },
    offers: ['new_website', 'local_seo'],
  },
  site_broken: {
    category: 'presence',
    severity: 'critical',
    title: { en: 'Website unreachable', fr: 'Site inaccessible' },
    explanation: {
      en: 'The website did not answer properly (server error, timeout, DNS or certificate failure, or not found).',
      fr: 'Le site n’a pas répondu correctement (erreur serveur, délai dépassé, échec DNS ou certificat, page introuvable).',
    },
    recommendation: {
      en: 'Restore the website or move it to reliable hosting.',
      fr: 'Rétablir le site ou le migrer vers un hébergement fiable.',
    },
    offers: ['website_redesign', 'new_website'],
  },
  no_https: {
    category: 'security',
    severity: 'major',
    title: { en: 'No HTTPS', fr: 'Pas de HTTPS' },
    explanation: {
      en: 'Browsers mark the site as “Not secure”, which puts visitors off.',
      fr: 'Les navigateurs signalent le site comme « Non sécurisé », ce qui fait fuir les visiteurs.',
    },
    recommendation: { en: 'Serve the site over HTTPS.', fr: 'Servir le site en HTTPS.' },
    offers: ['website_redesign'],
  },
  certificate_invalid: {
    category: 'security',
    severity: 'critical',
    title: { en: 'Invalid certificate', fr: 'Certificat invalide' },
    explanation: {
      en: 'The security certificate is not valid: browsers show a warning page.',
      fr: 'Le certificat de sécurité n’est pas valide : les navigateurs affichent un avertissement.',
    },
    recommendation: {
      en: 'Install a valid certificate (free with automatic renewal).',
      fr: 'Installer un certificat valide (gratuit, avec renouvellement automatique).',
    },
    offers: ['website_redesign'],
  },
  certificate_expiring: {
    category: 'security',
    severity: 'major',
    title: { en: 'Certificate expires soon', fr: 'Certificat bientôt expiré' },
    explanation: {
      en: 'The security certificate expires within 14 days.',
      fr: 'Le certificat de sécurité expire dans moins de 14 jours.',
    },
    recommendation: {
      en: 'Renew it, ideally with automatic renewal.',
      fr: 'Le renouveler, idéalement de façon automatique.',
    },
    offers: ['website_redesign'],
  },
  mixed_content: {
    category: 'security',
    severity: 'minor',
    title: { en: 'Mixed content', fr: 'Contenu mixte' },
    explanation: {
      en: 'Secure pages load some resources over plain HTTP.',
      fr: 'Des pages sécurisées chargent certaines ressources en HTTP simple.',
    },
    recommendation: { en: 'Load every resource over HTTPS.', fr: 'Charger toutes les ressources en HTTPS.' },
    offers: ['website_redesign'],
  },
  no_viewport_meta: {
    category: 'mobile',
    severity: 'major',
    title: { en: 'Not built for phones', fr: 'Non adapté aux mobiles' },
    explanation: {
      en: 'The site does not declare a mobile viewport: phones show a shrunken desktop page.',
      fr: 'Le site ne déclare pas de viewport mobile : les téléphones affichent une page de bureau réduite.',
    },
    recommendation: {
      en: 'Rebuild the site responsive, mobile first.',
      fr: 'Refaire le site en responsive, pensé d’abord pour le mobile.',
    },
    offers: ['website_redesign'],
  },
  poor_mobile_usability: {
    category: 'mobile',
    severity: 'major',
    title: { en: 'Hard to use on a phone', fr: 'Difficile à utiliser sur téléphone' },
    explanation: {
      en: 'On a phone, text, buttons or layout are hard to read or use.',
      fr: 'Sur téléphone, les textes, boutons ou la mise en page sont difficiles à lire ou à utiliser.',
    },
    recommendation: {
      en: 'Redesign the mobile layout: larger text, thumb-friendly buttons.',
      fr: 'Repenser l’affichage mobile : textes plus grands, boutons faciles à toucher.',
    },
    offers: ['website_redesign'],
  },
  slow_lcp_mobile: {
    category: 'performance',
    severity: 'major',
    title: { en: 'Slow to load on mobile', fr: 'Lent à charger sur mobile' },
    explanation: {
      en: 'The main content takes more than 4 seconds to appear on a phone.',
      fr: 'Le contenu principal met plus de 4 secondes à s’afficher sur téléphone.',
    },
    recommendation: {
      en: 'Optimize images and hosting, and remove heavy scripts.',
      fr: 'Optimiser les images et l’hébergement, retirer les scripts lourds.',
    },
    offers: ['website_redesign'],
  },
  layout_shift: {
    category: 'performance',
    severity: 'minor',
    title: { en: 'Content jumps while loading', fr: 'Le contenu saute au chargement' },
    explanation: {
      en: 'Elements move while the page loads (layout shift above 0.25).',
      fr: 'Des éléments bougent pendant le chargement (décalage supérieur à 0,25).',
    },
    recommendation: {
      en: 'Reserve space for images and embeds.',
      fr: 'Réserver la place des images et des contenus intégrés.',
    },
    offers: ['website_redesign'],
  },
  low_performance_score: {
    category: 'performance',
    severity: 'major',
    title: { en: 'Poor performance score', fr: 'Mauvais score de performance' },
    explanation: {
      en: 'Google’s PageSpeed performance score is below 50 (on mobile, else on desktop).',
      fr: 'Le score de performance PageSpeed de Google est inférieur à 50 (sur mobile, sinon sur ordinateur).',
    },
    recommendation: {
      en: 'Rebuild on a fast, modern stack.',
      fr: 'Reconstruire le site sur une base moderne et rapide.',
    },
    offers: ['website_redesign'],
  },
  heavy_page: {
    category: 'performance',
    severity: 'minor',
    title: { en: 'Heavy page', fr: 'Page trop lourde' },
    explanation: {
      en: 'The home page weighs more than 4 MB, costly on mobile data.',
      fr: 'La page d’accueil pèse plus de 4 Mo, coûteux en données mobiles.',
    },
    recommendation: {
      en: 'Compress images and remove unused resources.',
      fr: 'Compresser les images et retirer les ressources inutiles.',
    },
    offers: ['website_redesign'],
  },
  no_contact_visible: {
    category: 'conversion',
    severity: 'major',
    title: { en: 'No phone or e-mail on the site', fr: 'Ni téléphone ni e-mail sur le site' },
    explanation: {
      en: 'Visitors cannot find a phone number or an e-mail address.',
      fr: 'Les visiteurs ne trouvent ni numéro de téléphone ni adresse e-mail.',
    },
    recommendation: {
      en: 'Show phone, e-mail and WhatsApp on every page.',
      fr: 'Afficher téléphone, e-mail et WhatsApp sur chaque page.',
    },
    offers: ['website_redesign', 'ai_receptionist'],
  },
  no_contact_form: {
    category: 'conversion',
    severity: 'minor',
    title: { en: 'No contact form', fr: 'Pas de formulaire de contact' },
    explanation: {
      en: 'Visitors who prefer writing have no form to reach the business.',
      fr: 'Les visiteurs qui préfèrent écrire n’ont pas de formulaire pour contacter l’établissement.',
    },
    recommendation: { en: 'Add a simple contact form.', fr: 'Ajouter un formulaire de contact simple.' },
    offers: ['website_redesign', 'ai_receptionist'],
  },
  no_online_booking: {
    category: 'conversion',
    severity: 'major',
    title: { en: 'No online booking', fr: 'Pas de réservation en ligne' },
    explanation: {
      en: 'An appointment-based business without online booking loses customers who will not call.',
      fr: 'Un établissement sur rendez-vous sans réservation en ligne perd les clients qui n’appellent pas.',
    },
    recommendation: {
      en: 'Add online booking connected to the calendar.',
      fr: 'Ajouter la réservation en ligne reliée à l’agenda.',
    },
    offers: ['booking_system', 'ai_receptionist'],
  },
  no_online_menu: {
    category: 'conversion',
    severity: 'major',
    title: { en: 'No menu online', fr: 'Pas de carte en ligne' },
    explanation: {
      en: 'Diners cannot see the menu or prices before coming.',
      fr: 'Les clients ne voient ni la carte ni les prix avant de venir.',
    },
    recommendation: {
      en: 'Publish the menu as a page (not only a PDF).',
      fr: 'Publier la carte sous forme de page (pas seulement un PDF).',
    },
    offers: ['website_redesign', 'new_website'],
  },
  missing_english: {
    category: 'conversion',
    severity: 'major',
    title: { en: 'No English version', fr: 'Pas de version anglaise' },
    explanation: {
      en: 'Many visitors are English-speaking tourists, but the site is only in French.',
      fr: 'De nombreux visiteurs sont des touristes anglophones, mais le site n’existe qu’en français.',
    },
    recommendation: { en: 'Add an English version.', fr: 'Ajouter une version anglaise.' },
    offers: ['website_redesign', 'local_seo'],
  },
  missing_french: {
    category: 'conversion',
    severity: 'minor',
    title: { en: 'No French version', fr: 'Pas de version française' },
    explanation: {
      en: 'The business is in a French-speaking area, but the site is only in English.',
      fr: 'L’établissement est en zone francophone, mais le site n’existe qu’en anglais.',
    },
    recommendation: { en: 'Add a French version.', fr: 'Ajouter une version française.' },
    offers: ['website_redesign', 'local_seo'],
  },
  weak_call_to_action: {
    category: 'conversion',
    severity: 'minor',
    title: { en: 'Unclear call to action', fr: 'Appel à l’action peu clair' },
    explanation: {
      en: 'Visitors do not see what to do next (book, call, order).',
      fr: 'Les visiteurs ne voient pas quoi faire ensuite (réserver, appeler, commander).',
    },
    recommendation: {
      en: 'Make one main action prominent on every page.',
      fr: 'Mettre en avant une action principale sur chaque page.',
    },
    offers: ['website_redesign'],
  },
  stale_copyright: {
    category: 'freshness',
    severity: 'minor',
    title: { en: 'Looks unmaintained', fr: 'Semble à l’abandon' },
    explanation: {
      en: 'The copyright year is more than two years old.',
      fr: 'L’année du copyright date de plus de deux ans.',
    },
    recommendation: {
      en: 'Update the site and keep content current.',
      fr: 'Mettre le site à jour et garder le contenu actuel.',
    },
    offers: ['website_redesign'],
  },
  outdated_jquery: {
    category: 'freshness',
    severity: 'minor',
    title: { en: 'Outdated jQuery', fr: 'jQuery obsolète' },
    explanation: {
      en: 'The site uses jQuery older than version 3, with known security issues.',
      fr: 'Le site utilise une version de jQuery antérieure à la 3, avec des failles connues.',
    },
    recommendation: {
      en: 'Update or remove old libraries.',
      fr: 'Mettre à jour ou retirer les vieilles bibliothèques.',
    },
    offers: ['website_redesign'],
  },
  outdated_wordpress: {
    category: 'freshness',
    severity: 'major',
    title: { en: 'Outdated WordPress', fr: 'WordPress obsolète' },
    explanation: {
      en: 'The site runs an old major version of WordPress, no longer patched.',
      fr: 'Le site tourne sur une ancienne version majeure de WordPress, plus corrigée.',
    },
    recommendation: {
      en: 'Update WordPress or move to a maintained platform.',
      fr: 'Mettre WordPress à jour ou passer sur une plateforme maintenue.',
    },
    offers: ['website_redesign'],
  },
  dated_design: {
    category: 'design',
    severity: 'major',
    title: { en: 'Dated design', fr: 'Design daté' },
    explanation: {
      en: 'The design looks old-fashioned compared with current websites.',
      fr: 'Le design paraît daté par rapport aux sites actuels.',
    },
    recommendation: { en: 'Redesign with a modern look.', fr: 'Refaire le design avec un style moderne.' },
    offers: ['website_redesign'],
  },
  broken_links: {
    category: 'seo',
    severity: 'minor',
    title: { en: 'Broken links', fr: 'Liens cassés' },
    explanation: {
      en: 'Some internal links lead to missing pages.',
      fr: 'Certains liens internes mènent à des pages inexistantes.',
    },
    recommendation: { en: 'Fix or remove broken links.', fr: 'Corriger ou retirer les liens cassés.' },
    offers: ['website_redesign', 'local_seo'],
  },
  low_seo_score: {
    category: 'seo',
    severity: 'minor',
    title: { en: 'Weak search basics', fr: 'Bases du référencement faibles' },
    explanation: {
      en: 'Google’s PageSpeed SEO score is below 70 (titles, descriptions, crawlability).',
      fr: 'Le score SEO PageSpeed de Google est inférieur à 70 (titres, descriptions, indexation).',
    },
    recommendation: {
      en: 'Fix titles, descriptions and indexing.',
      fr: 'Corriger titres, descriptions et indexation.',
    },
    offers: ['local_seo', 'website_redesign'],
  },
  low_accessibility_score: {
    category: 'accessibility',
    severity: 'minor',
    title: { en: 'Accessibility issues', fr: 'Problèmes d’accessibilité' },
    explanation: {
      en: 'Google’s PageSpeed accessibility score is below 70 (contrast, labels, alternatives).',
      fr: 'Le score d’accessibilité PageSpeed de Google est inférieur à 70 (contrastes, libellés, alternatives).',
    },
    recommendation: {
      en: 'Improve contrast, labels and image descriptions.',
      fr: 'Améliorer contrastes, libellés et descriptions d’images.',
    },
    offers: ['website_redesign'],
  },
  no_solicitation_notice: {
    category: 'compliance',
    severity: 'info',
    title: { en: 'Asks not to be solicited', fr: 'Refuse la prospection' },
    explanation: {
      en: 'The site states that the business does not want commercial solicitation.',
      fr: 'Le site indique que l’établissement ne souhaite pas être démarché.',
    },
    recommendation: {
      en: 'Respect it: compliance decides whether any contact is allowed.',
      fr: 'Le respecter : la conformité décide si un contact est permis.',
    },
    offers: [],
  },
} as const satisfies Record<string, FindingDefinition>;

export type FindingCode = keyof typeof FINDING_DEFINITIONS;
export const FINDING_CODES = Object.keys(FINDING_DEFINITIONS) as [FindingCode, ...FindingCode[]];
export const FindingCodeSchema = z.enum(FINDING_CODES);

export const FindingSchema = z
  .object({
    code: FindingCodeSchema,
    severity: FindingSeveritySchema,
    /** What was measured or seen (never page text). */
    evidence: z.string().max(300),
    metric: z.object({ name: z.string().max(40), value: z.number(), threshold: z.number() }).nullable(),
    offerRelevance: z.array(OfferSchema),
  })
  .meta({ id: 'WebsiteFinding' });
export type Finding = z.infer<typeof FindingSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Audit

/**
 * DECISION(BF-030): `none` (no website) is never stored: a business without a website has no crawl, hence no audit.
 * Consumers (scoring, outreach, the listing filter `website=none`) derive it from `businesses.website_url IS NULL`,
 * the strongest offer signal (`new_website`); `BusinessWebsiteAudit.status` reports it for such a business.
 */
export const WEBSITE_STATUSES = ['none', 'parked', 'social_only', 'broken', 'weak', 'ok', 'strong'] as const;
export const WebsiteStatusSchema = z.enum(WEBSITE_STATUSES);
export type WebsiteStatus = z.infer<typeof WebsiteStatusSchema>;

/** Statuses the listing filter `website=weak` matches (a site exists but serves the business poorly). */
export const WEAK_WEBSITE_STATUSES: readonly WebsiteStatus[] = ['weak', 'broken'];

export const WebsiteAuditSchema = z
  .object({
    id: z.uuid(),
    businessId: z.uuid(),
    snapshotId: z.uuid(),
    psi: PsiResultSchema.nullable(),
    vision: VisionGradeSchema.nullable(),
    findings: z.array(FindingSchema),
    qualityScore: z
      .number()
      .int()
      .min(0)
      .max(100)
      .nullable()
      .describe('Null when neither PageSpeed nor the vision grade could measure the site.'),
    websiteStatus: WebsiteStatusSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .meta({ id: 'WebsiteAudit' });
export type WebsiteAudit = z.infer<typeof WebsiteAuditSchema>;

/** `GET /v1/businesses/:id/website-audit`: the audit of the business's latest crawl, if any. */
export const BusinessWebsiteAuditSchema = z
  .object({
    audit: WebsiteAuditSchema.nullable(),
    /** `none` for a business without a website, else the latest audit's status (null before the first audit). */
    status: WebsiteStatusSchema.nullable(),
  })
  .meta({ id: 'BusinessWebsiteAudit' });
export type BusinessWebsiteAudit = z.infer<typeof BusinessWebsiteAuditSchema>;
