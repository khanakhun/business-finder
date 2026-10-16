import { FINDING_CODES, type FindingCode, type PsiStrategyResult, VISION_CRITERIA } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import {
  type AuditFacts,
  type AuditSnapshot,
  assessWebsite,
  evaluateFindings,
  qualityScore,
  RULES,
  websiteStatus,
} from './website-audit.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');

const page = (kind: AuditSnapshot['pages'][number]['kind'], url: string) => ({
  url,
  kind,
  title: null,
  metaDescription: null,
  lang: 'fr',
  h1: null,
  wordCount: 100,
  markdownKey: null,
});

/** A healthy, readable site with nothing to report. */
const snapshot = (overrides: Partial<AuditSnapshot> = {}): AuditSnapshot => ({
  reachability: 'ok',
  socialOnly: false,
  tls: { valid: true, expiresAt: '2027-03-01T00:00:00.000Z', issuer: 'Fake CA' },
  security: { https: true, hsts: true, mixedContent: false },
  pages: [
    page('home', 'https://site.example/'),
    page('menu', 'https://site.example/menu'),
    page('booking', 'https://site.example/booking'),
  ],
  languages: { declared: ['fr', 'en'], detected: ['fr', 'en'], hreflang: [], hasLanguageSwitcher: true },
  contacts: {
    emails: [{ value: 'contact@site.example' }],
    phones: [{ value: '+33199001234' }],
    whatsappLinks: [],
    contactForms: [{ pageUrl: 'https://site.example/contact', action: null }],
  } as unknown as AuditSnapshot['contacts'],
  booking: { providers: [{ name: 'Fake booking', evidence: 'script host' }] },
  tech: [],
  freshness: { copyrightYear: 2026, httpLastModified: null, sitemapLastmod: null, latestDatedContent: null },
  mobile: { hasViewportMeta: true, fontSizeIssues: null },
  performanceHints: { pageWeightKb: 1_200, requestCount: 40, domContentLoadedMs: 900 },
  links: { internalCount: 20, brokenCount: 0 },
  noSolicitation: { checked: true, detected: false, phrases: [], pageUrl: null, snippet: null },
  ...overrides,
});

const strategy = (
  overrides: Partial<PsiStrategyResult['scores']> = {},
  metrics: Partial<PsiStrategyResult['metrics']> = {},
): PsiStrategyResult => ({
  scores: { performance: 90, accessibility: 95, bestPractices: 100, seo: 100, ...overrides },
  metrics: {
    lcpMs: 1_800,
    cls: 0.02,
    tbtMs: 50,
    fcpMs: 900,
    speedIndexMs: 1_500,
    ttfbMs: 300,
    inpMs: null,
    ...metrics,
  },
  opportunities: [],
  lighthouseVersion: '12.0.0',
  fetchedAt: NOW.toISOString(),
});

const vision = (score = 8, overrides: Partial<Record<(typeof VISION_CRITERIA)[number], number>> = {}) => ({
  criteria: Object.fromEntries(
    VISION_CRITERIA.map((criterion) => [
      criterion,
      { score: overrides[criterion] ?? score, evidence: `${criterion} evidence` },
    ]),
  ) as AuditFacts['vision'] extends infer V ? (V extends { criteria: infer C } ? C : never) : never,
  overall: score,
  summary: { en: 'Fine.', fr: 'Bien.' },
  model: 'vision-model',
  promptVersion: 1,
  gradedAt: NOW.toISOString(),
});

const facts = (overrides: Partial<AuditFacts> = {}): AuditFacts => ({
  snapshot: snapshot(),
  psi: { mobile: strategy(), desktop: strategy() },
  vision: vision(),
  business: {
    countryCode: 'BL',
    categoryAttributes: { hospitality: true, tourismFacing: true, appointmentBased: true },
    servesFood: true,
  },
  now: NOW,
  ...overrides,
});

const codes = (input: AuditFacts) => evaluateFindings(input).map((finding) => finding.code);

describe('findings rules', () => {
  it('has at least 20 rules, one per registered finding, with EN/FR texts', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(20);
    expect(RULES.map((rule) => rule.code).sort()).toEqual([...FINDING_CODES].sort());
  });

  it('reports nothing for a healthy site', () => {
    expect(codes(facts())).toEqual([]);
  });

  const cases: ReadonlyArray<[FindingCode, Partial<AuditFacts>]> = [
    ['parked_domain', { snapshot: snapshot({ reachability: 'parked' }) }],
    ['social_only', { snapshot: snapshot({ socialOnly: true }) }],
    ['site_broken', { snapshot: snapshot({ reachability: 'timeout' }) }],
    ['no_https', { snapshot: snapshot({ security: { https: false, hsts: false, mixedContent: false } }) }],
    ['certificate_invalid', { snapshot: snapshot({ tls: { valid: false, expiresAt: null, issuer: null } }) }],
    [
      'certificate_expiring',
      { snapshot: snapshot({ tls: { valid: true, expiresAt: '2026-10-20T00:00:00.000Z', issuer: null } }) },
    ],
    ['mixed_content', { snapshot: snapshot({ security: { https: true, hsts: false, mixedContent: true } }) }],
    [
      'no_viewport_meta',
      { snapshot: snapshot({ mobile: { hasViewportMeta: false, fontSizeIssues: null } }) },
    ],
    ['poor_mobile_usability', { vision: vision(8, { mobile_usability: 3 }) }],
    ['slow_lcp_mobile', { psi: { mobile: strategy({}, { lcpMs: 5_200 }), desktop: null } }],
    ['layout_shift', { psi: { mobile: strategy({}, { cls: 0.31 }), desktop: null } }],
    ['low_performance_score', { psi: { mobile: strategy({ performance: 42 }), desktop: null } }],
    [
      'heavy_page',
      {
        snapshot: snapshot({
          performanceHints: { pageWeightKb: 5_000, requestCount: null, domContentLoadedMs: null },
        }),
      },
    ],
    [
      'no_contact_visible',
      {
        snapshot: snapshot({
          contacts: {
            emails: [],
            phones: [],
            whatsappLinks: [],
            contactForms: [{ pageUrl: 'https://s.example/c', action: null }],
          },
        } as Partial<AuditSnapshot>),
      },
    ],
    [
      'no_contact_form',
      {
        snapshot: snapshot({
          contacts: { emails: [{ value: 'a@s.example' }], phones: [], whatsappLinks: [], contactForms: [] },
        } as unknown as Partial<AuditSnapshot>),
      },
    ],
    [
      'no_online_booking',
      {
        snapshot: snapshot({
          booking: { providers: [] },
          pages: [page('menu', 'https://s.example/menu')],
        } as unknown as Partial<AuditSnapshot>),
      },
    ],
    [
      'no_online_menu',
      {
        snapshot: snapshot({
          pages: [page('booking', 'https://s.example/book')],
        } as unknown as Partial<AuditSnapshot>),
      },
    ],
    [
      'missing_english',
      {
        snapshot: snapshot({
          languages: { declared: ['fr'], detected: ['fr'], hreflang: [], hasLanguageSwitcher: false },
        }),
      },
    ],
    [
      'missing_french',
      {
        snapshot: snapshot({
          languages: { declared: ['en'], detected: ['en'], hreflang: [], hasLanguageSwitcher: false },
        }),
      },
    ],
    ['weak_call_to_action', { vision: vision(8, { cta_clarity: 2 }) }],
    [
      'stale_copyright',
      {
        snapshot: snapshot({
          freshness: {
            copyrightYear: 2021,
            httpLastModified: null,
            sitemapLastmod: null,
            latestDatedContent: null,
          },
        }),
      },
    ],
    [
      'outdated_jquery',
      {
        snapshot: snapshot({
          tech: [{ name: 'jQuery', version: '1.12.4', categories: [], confidence: 100 }],
        }),
      },
    ],
    [
      'outdated_wordpress',
      {
        snapshot: snapshot({
          tech: [{ name: 'WordPress', version: '4.9.8', categories: [], confidence: 100 }],
        }),
      },
    ],
    ['dated_design', { vision: vision(8, { modernity: 3 }) }],
    ['broken_links', { snapshot: snapshot({ links: { internalCount: 10, brokenCount: 2 } }) }],
    ['low_seo_score', { psi: { mobile: strategy({ seo: 61 }), desktop: null } }],
    ['low_accessibility_score', { psi: { mobile: strategy({ accessibility: 55 }), desktop: null } }],
    [
      'no_solicitation_notice',
      {
        snapshot: snapshot({
          noSolicitation: {
            checked: true,
            detected: true,
            phrases: ['stop pub'],
            pageUrl: null,
            snippet: null,
          },
        }),
      },
    ],
  ];

  it.each(cases)('%s applies on its condition', (code, overrides) => {
    expect(codes(facts(overrides))).toContain(code);
  });

  it('keeps borderline values out', () => {
    // Exactly at thresholds: not reported.
    expect(
      codes(
        facts({
          psi: {
            mobile: strategy({ performance: 50, seo: 70, accessibility: 70 }, { lcpMs: 4_000, cls: 0.25 }),
            desktop: null,
          },
        }),
      ),
    ).toEqual([]);
    expect(
      codes(facts({ vision: vision(8, { modernity: 5, cta_clarity: 5, mobile_usability: 5 }) })),
    ).toEqual([]);
    expect(
      codes(
        facts({
          snapshot: snapshot({
            freshness: {
              copyrightYear: 2024,
              httpLastModified: null,
              sitemapLastmod: null,
              latestDatedContent: null,
            },
            tls: { valid: true, expiresAt: '2026-10-28T13:00:00.000Z', issuer: null },
            tech: [
              { name: 'jQuery', version: '3.7.1', categories: [], confidence: 100 },
              { name: 'WordPress', version: '6.6', categories: [], confidence: 100 },
            ],
          }),
        }),
      ),
    ).toEqual([]);
  });

  it('builds evidence from measurements only, never page text or model prose', () => {
    const findings = evaluateFindings(
      facts({
        snapshot: snapshot({
          tech: [
            { name: 'jQuery', version: '1.12.4', categories: [], confidence: 100 },
            // Not a version: ignored, and never repeated.
            { name: 'WordPress', version: '4 — call +33 1 99 00 12 34', categories: [], confidence: 100 },
          ],
        }),
        vision: {
          ...vision(8, { modernity: 2 }),
          criteria: {
            ...vision(8, { modernity: 2 }).criteria,
            modernity: { score: 2, evidence: 'Banner says: ask Marie at +33 1 99 00 12 34' },
          },
        },
      }),
    );
    expect(findings.map((f) => f.code)).toEqual(['dated_design', 'outdated_jquery']);
    expect(findings.map((f) => f.evidence)).toEqual(['Visual grade — modernity: 2/10.', 'jQuery 1.x.']);
  });

  it('applies context rules only to the businesses they concern', () => {
    const plain = { countryCode: 'US', categoryAttributes: {}, servesFood: false };
    const bare = snapshot({
      booking: { providers: [] },
      pages: [],
      languages: { declared: ['en'], detected: ['en'], hreflang: [], hasLanguageSwitcher: false },
    } as unknown as Partial<AuditSnapshot>);
    expect(codes(facts({ business: plain, snapshot: bare }))).toEqual([]);
    // A no-solicitation statement not actually checked is not a finding.
    expect(
      codes(
        facts({
          snapshot: snapshot({
            noSolicitation: { checked: false, detected: true, phrases: [], pageUrl: null, snippet: null },
          }),
        }),
      ),
    ).toEqual([]);
  });

  it('reads only presence on unreadable sites, sorted by severity', () => {
    const broken = facts({
      snapshot: snapshot({
        reachability: 'server_error',
        security: { https: false, hsts: false, mixedContent: true },
      }),
      psi: null,
      vision: null,
    });
    expect(codes(broken)).toEqual(['site_broken']);
    const findings = evaluateFindings(
      facts({
        psi: { mobile: strategy({ performance: 20, seo: 60 }), desktop: null },
        snapshot: snapshot({ security: { https: false, hsts: false, mixedContent: false } }),
      }),
    );
    expect(findings.map((f) => [f.code, f.severity])).toEqual([
      ['low_performance_score', 'critical'],
      ['no_https', 'major'],
      ['low_seo_score', 'minor'],
    ]);
    expect(findings[0]?.metric).toEqual({ name: 'psi.mobile.performance', value: 20, threshold: 50 });
    expect(findings[0]?.offerRelevance).toEqual(['website_redesign']);
  });
});

describe('quality score and status', () => {
  it('weighs the available measurements and subtracts capped penalties', () => {
    // 0.4×80 + 0.25×90 + 0.15×95 + 0.1×100 + 0.1×100 = 88.75
    expect(qualityScore(facts(), [])).toBe(89);
    const findings = evaluateFindings(facts({ vision: vision(8, { modernity: 3 }) }));
    // dated_design (major, −6) on the same measurements.
    expect(qualityScore(facts({ vision: vision(8, { modernity: 3 }) }), findings)).toBe(83);
    // Vision only: renormalized to its own weight.
    expect(qualityScore(facts({ psi: null }), [])).toBe(80);
    // PageSpeed desktop stands in for missing mobile scores.
    expect(
      qualityScore(
        facts({ vision: null, psi: { mobile: null, desktop: strategy({ performance: 40 }) } }),
        [],
      ),
    ).toBe(Math.round((0.25 * 40 + 0.15 * 95 + 0.1 * 100 + 0.1 * 100) / 0.6));
    // Penalties are capped at 40 and the score never goes below 0.
    const many = Array.from(
      { length: 10 },
      () => evaluateFindings(facts({ snapshot: snapshot({ reachability: 'parked' }) }))[0]!,
    );
    expect(qualityScore(facts({ vision: vision(2), psi: null }), many)).toBe(0);
    expect(qualityScore(facts({ vision: null, psi: null }), [])).toBeNull();
  });

  it('pins the boundaries of the score and the status', () => {
    // The 40-point cap: a base of 89 minus four critical findings (60 points) is 49, not 29.
    const critical = evaluateFindings(facts({ snapshot: snapshot({ reachability: 'parked' }) }))[0];
    expect(qualityScore(facts(), [critical, critical, critical, critical] as never)).toBe(49);
    expect(websiteStatus(facts(), [], 60)).toBe('ok');
    const unmeasured = { psi: null, vision: null };
    // One major finding alone keeps an unmeasured site ok; one critical makes it weak.
    expect(
      assessWebsite(
        facts({
          ...unmeasured,
          snapshot: snapshot({ security: { https: false, hsts: false, mixedContent: false } }),
        }),
      ).websiteStatus,
    ).toBe('ok');
    expect(
      assessWebsite(
        facts({
          ...unmeasured,
          snapshot: snapshot({ tls: { valid: false, expiresAt: null, issuer: null } }),
        }),
      ).websiteStatus,
    ).toBe('weak');
    // A crawler-blocking site with a measured score follows the score.
    expect(websiteStatus(facts({ snapshot: snapshot({ reachability: 'blocked' }) }), [], 40)).toBe('weak');
    // Exactly 25 on mobile performance is major, below is critical.
    expect(
      evaluateFindings(facts({ psi: { mobile: strategy({ performance: 25 }), desktop: null } }))[0]?.severity,
    ).toBe('major');
  });

  it('derives the status from presence, then the score', () => {
    const at = (overrides: Partial<AuditFacts>) => assessWebsite(facts(overrides)).websiteStatus;
    expect(at({})).toBe('strong');
    expect(
      at({
        vision: vision(6),
        psi: {
          mobile: strategy({ performance: 70, accessibility: 70, seo: 80, bestPractices: 80 }),
          desktop: null,
        },
      }),
    ).toBe('ok');
    expect(at({ vision: vision(3), psi: { mobile: strategy({ performance: 30 }), desktop: null } })).toBe(
      'weak',
    );
    expect(at({ snapshot: snapshot({ reachability: 'parked' }) })).toBe('parked');
    expect(at({ snapshot: snapshot({ socialOnly: true }) })).toBe('social_only');
    expect(at({ snapshot: snapshot({ reachability: 'dns_error' }), psi: null, vision: null })).toBe('broken');
    // Blocked crawlers: the site may work for visitors.
    expect(at({ snapshot: snapshot({ reachability: 'blocked' }), psi: null, vision: null })).toBe('ok');
    // Unmeasured readable sites: by findings.
    expect(at({ psi: null, vision: null })).toBe('ok');
    expect(
      at({
        psi: null,
        vision: null,
        snapshot: snapshot({
          security: { https: false, hsts: false, mixedContent: false },
          mobile: { hasViewportMeta: false, fontSizeIssues: null },
        }),
      }),
    ).toBe('weak');
    expect(websiteStatus(facts(), [], 80)).toBe('strong');
    expect(websiteStatus(facts(), [], 79)).toBe('ok');
    expect(websiteStatus(facts(), [], 59)).toBe('weak');
  });
});

describe('language and performance edge cases', () => {
  const languages = (value: AuditSnapshot['languages']) =>
    codes(facts({ snapshot: snapshot({ languages: value }) }));

  it('reads the languages from the text and hreflang, not a theme’s declared lang', () => {
    // A French site whose theme declares `en-US`: English is missing.
    expect(
      languages({ declared: ['en-US'], detected: ['fr'], hreflang: [], hasLanguageSwitcher: false }),
    ).toContain('missing_english');
    // `x-default` is no language; `en-GB` alternates count as English.
    expect(
      languages({
        declared: ['fr'],
        detected: ['fr'],
        hreflang: [
          { lang: 'x-default', url: 'https://s.example/' },
          { lang: 'en-GB', url: 'https://s.example/en' },
        ],
        hasLanguageSwitcher: true,
      }),
    ).not.toContain('missing_english');
    // Nothing detected: the declared language is all there is.
    expect(
      languages({ declared: ['fr-FR'], detected: [], hreflang: [], hasLanguageSwitcher: false }),
    ).toContain('missing_english');
    // Nothing known at all: no language finding.
    const unknown = languages({ declared: [], detected: [], hreflang: [], hasLanguageSwitcher: false });
    expect(unknown).not.toContain('missing_english');
    expect(unknown).not.toContain('missing_french');
  });

  it('falls back to desktop for the performance score when mobile was not measured', () => {
    const findings = evaluateFindings(
      facts({ psi: { mobile: null, desktop: strategy({ performance: 40 }) } }),
    );
    expect(findings.find((f) => f.code === 'low_performance_score')).toMatchObject({
      evidence: 'PageSpeed performance on desktop: 40/100.',
      metric: { name: 'psi.desktop.performance', value: 40, threshold: 50 },
    });
  });

  it('rates a site that blocks our crawler from PageSpeed alone', () => {
    const blocked = facts({ snapshot: snapshot({ reachability: 'blocked' }), vision: null });
    const findings = evaluateFindings(blocked);
    const score = qualityScore(blocked, findings);
    expect(score).not.toBeNull();
    expect(websiteStatus(blocked, findings, score)).toBe(score !== null && score >= 80 ? 'strong' : 'ok');
    const slow = facts({
      snapshot: snapshot({ reachability: 'blocked' }),
      vision: null,
      psi: {
        mobile: strategy({ performance: 20, accessibility: 40, seo: 40, bestPractices: 40 }),
        desktop: null,
      },
    });
    const slowFindings = evaluateFindings(slow);
    expect(websiteStatus(slow, slowFindings, qualityScore(slow, slowFindings))).toBe('weak');
    // Unmeasured, a blocked site is not presented as broken.
    expect(websiteStatus({ ...blocked, psi: null }, [], null)).toBe('ok');
  });
});
