import {
  type CategoryAttributes,
  FINDING_DEFINITIONS,
  type Finding,
  type FindingCode,
  type FindingSeverity,
  type PsiResult,
  type SiteIntel,
  type VisionGrade,
  type WebsiteStatus,
} from '@bf/contracts';

// Website audit rules (BF-030, pure): a Rules Engine over the snapshot, PageSpeed and the vision grade. Each rule is
// a Specification (`evaluate`) that yields a finding with its evidence; the quality score is a documented weighted
// composite (Strategy) and the website status follows from presence and score. Reproducible from stored inputs.
// Evidence is built from measurements and fixed text only — never page text or model prose (findings feed outreach
// and briefs).

/** The snapshot facts the rules read (a subset of SiteIntel, as stored). */
export type AuditSnapshot = Pick<
  SiteIntel,
  | 'reachability'
  | 'socialOnly'
  | 'tls'
  | 'security'
  | 'pages'
  | 'languages'
  | 'contacts'
  | 'booking'
  | 'tech'
  | 'freshness'
  | 'mobile'
  | 'performanceHints'
  | 'links'
  | 'noSolicitation'
>;

export interface AuditFacts {
  readonly snapshot: AuditSnapshot;
  readonly psi: PsiResult | null;
  readonly vision: VisionGrade | null;
  readonly business: {
    readonly countryCode: string | null;
    /** Effective attributes of the primary category (inherited from its ancestors). */
    readonly categoryAttributes: CategoryAttributes;
    /** The primary category is a food & drink one (menus matter). */
    readonly servesFood: boolean;
  };
  readonly now: Date;
}

type Hit = {
  readonly evidence: string;
  readonly metric?: Finding['metric'];
  readonly severity?: FindingSeverity;
};

interface Rule {
  readonly code: FindingCode;
  /** The finding's evidence when it applies, else null. */
  readonly evaluate: (facts: AuditFacts) => Hit | null;
}

const DAY_MS = 86_400_000;
/** French-speaking places where an English version matters for tourists (and a French one for residents). */
const FRENCH_SPEAKING = new Set([
  'FR',
  'BL',
  'MF',
  'GP',
  'MQ',
  'GF',
  'RE',
  'YT',
  'PM',
  'NC',
  'PF',
  'WF',
  'MC',
]);
const BROKEN: ReadonlySet<SiteIntel['reachability']> = new Set([
  'not_found',
  'server_error',
  'timeout',
  'dns_error',
  'tls_error',
]);

const readable = (facts: AuditFacts) =>
  !facts.snapshot.socialOnly &&
  (facts.snapshot.reachability === 'ok' || facts.snapshot.reachability === 'redirected');
/**
 * The languages the site is written in: detected from its text plus its hreflang alternates; the declared `lang`
 * only when nothing was detected (themes often ship `lang="en-US"` on a French site). ISO 639-1 codes only
 * (`x-default` is not a language).
 */
const languagesOf = (snapshot: AuditSnapshot) => {
  const { declared, detected, hreflang } = snapshot.languages;
  const read = [...detected, ...hreflang.map((h) => h.lang)];
  return new Set(
    (read.length > 0 ? read : declared)
      .map((lang) => lang.toLowerCase().split(/[-_]/)[0] ?? '')
      .filter((lang) => /^[a-z]{2}$/.test(lang)),
  );
};
/**
 * The major version of a well-formed version string (`1.12.4` → 1); null otherwise. Evidence never repeats the
 * string itself: it comes from the page.
 */
const major = (version: string | null) =>
  version && /^\d+(\.\d+){0,3}$/.test(version) ? Number.parseInt(version, 10) : null;
const seconds = (msValue: number) => `${(msValue / 1000).toFixed(1)} s`;
const visionScore = (facts: AuditFacts, criterion: keyof VisionGrade['criteria']) =>
  facts.vision?.criteria[criterion]?.score ?? null;

/** Rules in report order. Presence rules make the others moot (they need a readable site). */
export const RULES: readonly Rule[] = [
  {
    code: 'parked_domain',
    evaluate: ({ snapshot }) =>
      snapshot.reachability === 'parked' ? { evidence: 'The domain shows a parking page.' } : null,
  },
  {
    code: 'social_only',
    evaluate: ({ snapshot }) =>
      snapshot.socialOnly ? { evidence: 'The website address is a social profile or link page.' } : null,
  },
  {
    code: 'site_broken',
    evaluate: ({ snapshot }) =>
      BROKEN.has(snapshot.reachability) ? { evidence: `The site answered: ${snapshot.reachability}.` } : null,
  },
  {
    code: 'no_https',
    evaluate: (facts) =>
      readable(facts) && !facts.snapshot.security.https
        ? { evidence: 'The site is served over plain HTTP.' }
        : null,
  },
  {
    code: 'certificate_invalid',
    evaluate: (facts) =>
      readable(facts) && facts.snapshot.security.https && facts.snapshot.tls.valid === false
        ? { evidence: 'The TLS certificate did not validate.' }
        : null,
  },
  {
    code: 'certificate_expiring',
    evaluate: (facts) => {
      const expiresAt = facts.snapshot.tls.expiresAt ? Date.parse(facts.snapshot.tls.expiresAt) : Number.NaN;
      if (!readable(facts) || !Number.isFinite(expiresAt) || facts.snapshot.tls.valid === false) return null;
      const days = Math.floor((expiresAt - facts.now.getTime()) / DAY_MS);
      return days < 14 ? { evidence: `The certificate expires in ${Math.max(0, days)} day(s).` } : null;
    },
  },
  {
    code: 'mixed_content',
    evaluate: (facts) =>
      readable(facts) && facts.snapshot.security.mixedContent
        ? { evidence: 'Secure pages load resources over HTTP.' }
        : null,
  },
  {
    code: 'no_viewport_meta',
    evaluate: (facts) =>
      readable(facts) && !facts.snapshot.mobile.hasViewportMeta
        ? { evidence: 'No viewport meta tag on the home page.' }
        : null,
  },
  {
    code: 'poor_mobile_usability',
    evaluate: (facts) => {
      const value = visionScore(facts, 'mobile_usability');
      return value !== null && value <= 4
        ? {
            evidence: `Visual grade — mobile usability: ${value}/10.`,
            metric: { name: 'vision.mobile_usability', value, threshold: 4 },
          }
        : null;
    },
  },
  {
    code: 'slow_lcp_mobile',
    evaluate: ({ psi }) => {
      const value = psi?.mobile?.metrics.lcpMs ?? null;
      return value !== null && value > 4_000
        ? {
            evidence: `Largest contentful paint on mobile: ${seconds(value)}.`,
            metric: { name: 'lcpMs', value, threshold: 4_000 },
          }
        : null;
    },
  },
  {
    code: 'layout_shift',
    evaluate: ({ psi }) => {
      const value = psi?.mobile?.metrics.cls ?? psi?.desktop?.metrics.cls ?? null;
      return value !== null && value > 0.25
        ? {
            evidence: `Cumulative layout shift: ${value.toFixed(2)}.`,
            metric: { name: 'cls', value, threshold: 0.25 },
          }
        : null;
    },
  },
  {
    code: 'low_performance_score',
    evaluate: ({ psi }) => {
      // Mobile first (most visitors), desktop when only desktop was measured.
      const strategy = psi?.mobile ? 'mobile' : 'desktop';
      const value = psi?.[strategy]?.scores.performance ?? null;
      return value !== null && value < 50
        ? {
            evidence: `PageSpeed performance on ${strategy}: ${value}/100.`,
            metric: { name: `psi.${strategy}.performance`, value, threshold: 50 },
            // Very slow sites lose most mobile visitors.
            ...(value < 25 ? { severity: 'critical' as const } : {}),
          }
        : null;
    },
  },
  {
    code: 'heavy_page',
    evaluate: (facts) => {
      const kb = facts.snapshot.performanceHints.pageWeightKb;
      return readable(facts) && kb !== null && kb > 4_096
        ? {
            evidence: `Home page weight: ${(kb / 1024).toFixed(1)} MB.`,
            metric: { name: 'pageWeightKb', value: kb, threshold: 4_096 },
          }
        : null;
    },
  },
  {
    code: 'no_contact_visible',
    evaluate: (facts) =>
      readable(facts) &&
      facts.snapshot.contacts.emails.length === 0 &&
      facts.snapshot.contacts.phones.length === 0 &&
      facts.snapshot.contacts.whatsappLinks.length === 0
        ? { evidence: 'No phone number, e-mail address or WhatsApp link was found on the site.' }
        : null,
  },
  {
    code: 'no_contact_form',
    evaluate: (facts) =>
      readable(facts) && facts.snapshot.contacts.contactForms.length === 0
        ? { evidence: 'No contact form was found.' }
        : null,
  },
  {
    code: 'no_online_booking',
    evaluate: (facts) =>
      readable(facts) &&
      facts.business.categoryAttributes.appointmentBased === true &&
      facts.snapshot.booking.providers.length === 0 &&
      !facts.snapshot.pages.some((page) => page.kind === 'booking')
        ? { evidence: 'Appointment-based business; no booking tool or booking page was found.' }
        : null,
  },
  {
    code: 'no_online_menu',
    evaluate: (facts) =>
      readable(facts) &&
      facts.business.servesFood &&
      !facts.snapshot.pages.some((page) => page.kind === 'menu')
        ? { evidence: 'Food & drink business; no menu page was found.' }
        : null,
  },
  {
    code: 'missing_english',
    evaluate: (facts) => {
      if (!readable(facts) || facts.business.categoryAttributes.tourismFacing !== true) return null;
      if (!FRENCH_SPEAKING.has(facts.business.countryCode ?? '')) return null;
      const languages = languagesOf(facts.snapshot);
      return languages.size > 0 && !languages.has('en')
        ? { evidence: `Tourism-facing business; site languages: ${[...languages].join(', ')}.` }
        : null;
    },
  },
  {
    code: 'missing_french',
    evaluate: (facts) => {
      if (!readable(facts) || !FRENCH_SPEAKING.has(facts.business.countryCode ?? '')) return null;
      const languages = languagesOf(facts.snapshot);
      return languages.size > 0 && !languages.has('fr')
        ? { evidence: `French-speaking area; site languages: ${[...languages].join(', ')}.` }
        : null;
    },
  },
  {
    code: 'weak_call_to_action',
    evaluate: (facts) => {
      const value = visionScore(facts, 'cta_clarity');
      return value !== null && value <= 4
        ? {
            evidence: `Visual grade — call to action: ${value}/10.`,
            metric: { name: 'vision.cta_clarity', value, threshold: 4 },
          }
        : null;
    },
  },
  {
    code: 'stale_copyright',
    evaluate: (facts) => {
      const year = facts.snapshot.freshness.copyrightYear;
      const current = facts.now.getUTCFullYear();
      return readable(facts) && year !== null && year < current - 2
        ? {
            evidence: `Copyright ${year}.`,
            metric: { name: 'copyrightYear', value: year, threshold: current - 2 },
          }
        : null;
    },
  },
  {
    code: 'outdated_jquery',
    evaluate: (facts) => {
      const jquery = facts.snapshot.tech.find((tech) => tech.name.toLowerCase() === 'jquery');
      const version = major(jquery?.version ?? null);
      return readable(facts) && version !== null && version < 3
        ? {
            evidence: `jQuery ${version}.x.`,
            metric: { name: 'jquery.major', value: version, threshold: 3 },
          }
        : null;
    },
  },
  {
    code: 'outdated_wordpress',
    evaluate: (facts) => {
      const wordpress = facts.snapshot.tech.find((tech) => tech.name.toLowerCase() === 'wordpress');
      const version = major(wordpress?.version ?? null);
      // WordPress 6 is the maintained major line (5 and older no longer get feature releases).
      return readable(facts) && version !== null && version < 6
        ? {
            evidence: `WordPress ${version}.x.`,
            metric: { name: 'wordpress.major', value: version, threshold: 6 },
          }
        : null;
    },
  },
  {
    code: 'dated_design',
    evaluate: (facts) => {
      const value = visionScore(facts, 'modernity');
      return value !== null && value <= 4
        ? {
            evidence: `Visual grade — modernity: ${value}/10.`,
            metric: { name: 'vision.modernity', value, threshold: 4 },
          }
        : null;
    },
  },
  {
    code: 'broken_links',
    evaluate: (facts) =>
      readable(facts) && facts.snapshot.links.brokenCount > 0
        ? {
            evidence: `${facts.snapshot.links.brokenCount} broken internal link(s) among those checked.`,
            metric: { name: 'brokenLinks', value: facts.snapshot.links.brokenCount, threshold: 0 },
          }
        : null,
  },
  {
    code: 'low_seo_score',
    evaluate: ({ psi }) => {
      const value = psi?.mobile?.scores.seo ?? psi?.desktop?.scores.seo ?? null;
      return value !== null && value < 70
        ? { evidence: `PageSpeed SEO: ${value}/100.`, metric: { name: 'psi.seo', value, threshold: 70 } }
        : null;
    },
  },
  {
    code: 'low_accessibility_score',
    evaluate: ({ psi }) => {
      const value = psi?.mobile?.scores.accessibility ?? psi?.desktop?.scores.accessibility ?? null;
      return value !== null && value < 70
        ? {
            evidence: `PageSpeed accessibility: ${value}/100.`,
            metric: { name: 'psi.accessibility', value, threshold: 70 },
          }
        : null;
    },
  },
  {
    code: 'no_solicitation_notice',
    evaluate: ({ snapshot }) =>
      snapshot.noSolicitation.checked && snapshot.noSolicitation.detected
        ? { evidence: 'A no-solicitation statement was found on the site.' }
        : null,
  },
];

const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/** Every applicable finding, most severe first (registry order within a severity). */
export function evaluateFindings(facts: AuditFacts): Finding[] {
  const findings = RULES.flatMap((rule) => {
    const hit = rule.evaluate(facts);
    if (!hit) return [];
    const definition = FINDING_DEFINITIONS[rule.code];
    return [
      {
        code: rule.code,
        severity: hit.severity ?? definition.severity,
        evidence: hit.evidence.slice(0, 300),
        metric: hit.metric ?? null,
        offerRelevance: [...definition.offers],
      },
    ];
  });
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) => SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] || a.index - b.index,
    )
    .map(({ finding }) => finding);
}

/**
 * Quality score 0–100 (documented formula, BF-030):
 * 1. Weighted mean of the available measurements — vision overall ×10 (weight 0.40), PageSpeed mobile performance
 *    (0.25), mobile accessibility (0.15), SEO (0.10), best practices (0.10); weights are renormalized over what was
 *    measured (desktop scores stand in for missing mobile ones).
 * 2. Minus findings penalties: critical 15, major 6, minor 2, info 0 — at most 40 in total.
 * 3. Clamped to 0–100 and rounded. Null when nothing was measured (no PageSpeed, no vision grade).
 */
export const SCORE_WEIGHTS = {
  vision: 0.4,
  performance: 0.25,
  accessibility: 0.15,
  seo: 0.1,
  bestPractices: 0.1,
};
export const SEVERITY_PENALTY: Readonly<Record<FindingSeverity, number>> = {
  critical: 15,
  major: 6,
  minor: 2,
  info: 0,
};
export const MAX_PENALTY = 40;

export function qualityScore(facts: AuditFacts, findings: readonly Finding[]): number | null {
  const scores = facts.psi?.mobile?.scores;
  const fallback = facts.psi?.desktop?.scores;
  const parts: Array<readonly [number | null | undefined, number]> = [
    [facts.vision ? facts.vision.overall * 10 : null, SCORE_WEIGHTS.vision],
    [scores?.performance ?? fallback?.performance, SCORE_WEIGHTS.performance],
    [scores?.accessibility ?? fallback?.accessibility, SCORE_WEIGHTS.accessibility],
    [scores?.seo ?? fallback?.seo, SCORE_WEIGHTS.seo],
    [scores?.bestPractices ?? fallback?.bestPractices, SCORE_WEIGHTS.bestPractices],
  ];
  const measured = parts.filter((part): part is readonly [number, number] => typeof part[0] === 'number');
  if (measured.length === 0) return null;
  const weight = measured.reduce((sum, [, w]) => sum + w, 0);
  const base = measured.reduce((sum, [value, w]) => sum + value * w, 0) / weight;
  const penalty = Math.min(
    MAX_PENALTY,
    findings.reduce((sum, finding) => sum + SEVERITY_PENALTY[finding.severity], 0),
  );
  return Math.round(Math.max(0, Math.min(100, base - penalty)));
}

/**
 * Website status: presence first (parked, social profile, broken), then the score — strong ≥ 80, ok 60–79,
 * weak < 60. Unmeasured readable sites are `weak` with a critical or two major findings, else `ok`.
 */
export function websiteStatus(
  facts: AuditFacts,
  findings: readonly Finding[],
  score: number | null,
): WebsiteStatus {
  if (facts.snapshot.reachability === 'parked') return 'parked';
  if (facts.snapshot.socialOnly) return 'social_only';
  if (BROKEN.has(facts.snapshot.reachability) || facts.snapshot.reachability === 'blocked') {
    // A site that blocks our crawler may well work for visitors: only real failures are "broken".
    return facts.snapshot.reachability === 'blocked' ? (score === null ? 'ok' : statusOf(score)) : 'broken';
  }
  if (score !== null) return statusOf(score);
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const majorCount = findings.filter((f) => f.severity === 'major').length;
  return critical > 0 || majorCount >= 2 ? 'weak' : 'ok';
}

const statusOf = (score: number): WebsiteStatus => (score >= 80 ? 'strong' : score >= 60 ? 'ok' : 'weak');

export interface AuditOutcome {
  readonly findings: Finding[];
  readonly qualityScore: number | null;
  readonly websiteStatus: WebsiteStatus;
}

export function assessWebsite(facts: AuditFacts): AuditOutcome {
  const findings = evaluateFindings(facts);
  const score = qualityScore(facts, findings);
  return { findings, qualityScore: score, websiteStatus: websiteStatus(facts, findings, score) };
}
