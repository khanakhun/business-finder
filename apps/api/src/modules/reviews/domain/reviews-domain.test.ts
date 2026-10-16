import { describe, expect, it } from 'vitest';
import { resolveGate } from './gates.ts';
import { combineInsights, contributionOf, liveContributions } from './insights.ts';
import { detectLanguage } from './language.ts';
import { stripPersonalDetails } from './personal-details.ts';
import { type RatingObservation, ratingSummary } from './rating-trend.ts';
import type { ClassifiedReview } from './review.ts';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const DAY = 86_400_000;

describe('stripPersonalDetails', () => {
  it('replaces e-mails, links, handles and phone numbers', () => {
    expect(
      stripPersonalDetails(
        'Écrivez à resa.lavague@example.com ou sur www.la-vague.example/contact, insta @la_vague_sbh, ' +
          'tél +33 1 99 00 12 34 ou 01.99.00.56.78.',
      ),
    ).toBe('Écrivez à [email] ou sur [link] insta [handle], tél [phone] ou [phone].');
    expect(stripPersonalDetails('See https://example.com/x?y=1 now')).toBe('See [link] now');
  });

  it('keeps prices, times, years and short numbers', () => {
    const text = 'Table at 20h30 in 2026, 45 € per person, room 12, waited 90 minutes.';
    expect(stripPersonalDetails(text)).toBe(text);
  });

  it('removes the names the source attached, whole and word by word, in any case', () => {
    expect(
      stripPersonalDetails('MARIE was lovely, Marie Dupont even called back. Thanks marie!', [
        'Marie Dupont',
      ]),
    ).toBe('[person] was lovely, [person] even called back. Thanks [person]!');
    expect(stripPersonalDetails('Ok', ['J'])).toBe('Ok');
  });

  it('removes names after a title or a thank-you, but not ordinary words', () => {
    expect(stripPersonalDetails('Demandez Mme Laplace, et merci à Julie !')).toBe(
      'Demandez [person], et merci à [person] !',
    );
    expect(stripPersonalDetails('Ask for Mr. John Smith. Thanks Kevin and team.')).toBe(
      'Ask for [person]. Thanks [person] and team.',
    );
    expect(stripPersonalDetails('Merci Beaucoup ! Thanks Everyone.')).toBe(
      'Merci Beaucoup ! Thanks Everyone.',
    );
    // Lowercase words after "merci" are not names.
    expect(stripPersonalDetails('merci pour tout')).toBe('merci pour tout');
  });
});

describe('stripPersonalDetails boundaries', () => {
  it('treats eight digits or more as a phone, fewer as a number', () => {
    expect(stripPersonalDetails('Code 1234567 at the door')).toBe('Code 1234567 at the door');
    expect(stripPersonalDetails('Call 12345678')).toBe('Call [phone]');
  });

  it('documents its limits: capitalised words only, and attached names of three letters or more', () => {
    // An all-caps or lowercase name after a thank-you is not recognised (the prompt forbids names in paraphrases,
    // and paraphrases are checked again).
    expect(stripPersonalDetails('Merci JULIE')).toBe('Merci JULIE');
    expect(stripPersonalDetails('merci julie')).toBe('merci julie');
    // Short attached names are removed whole only, never as fragments of other words.
    expect(stripPersonalDetails('Jo was great, enjoy!', ['Jo'])).toBe('[person] was great, enjoy!');
  });
});

describe('detectLanguage', () => {
  it('trusts the source code, then counts stop words (Creole counts as French)', () => {
    expect(detectLanguage('whatever', 'en-US')).toBe('en');
    expect(detectLanguage('Le service était très lent mais la vue est top')).toBe('fr');
    expect(detectLanguage('The staff was great and the view is amazing')).toBe('en');
    expect(detectLanguage('Manjé-a té bon, mé pa ni pon moun ka réponn')).toBe('fr');
    expect(detectLanguage('👍👍')).toBe('und');
  });
});

const review = (overrides: Partial<ClassifiedReview> = {}): ClassifiedReview => ({
  tags: [],
  sentiment: 0,
  mentionsOwnerResponse: false,
  evidence: null,
  language: 'en',
  ownerResponded: null,
  ...overrides,
});

const meta = (overrides: Partial<Parameters<typeof contributionOf>[1]> = {}) => ({
  source: 'manual' as const,
  computedAt: NOW,
  expiresAt: null,
  model: 'fast-model',
  promptVersion: 1,
  ...overrides,
});

describe('aggregation', () => {
  const reviews = [
    review({ tags: ['booking_friction'], sentiment: -0.6, evidence: 'Booking online is impossible.' }),
    review({
      tags: ['booking_friction', 'unreachable_by_phone'],
      sentiment: -0.8,
      evidence: 'Nobody answers calls, so booking fails.',
    }),
    review({ tags: ['booking_friction'], sentiment: -0.2, evidence: 'Booking online is impossible.' }),
    review({ tags: ['booking_friction'], sentiment: 0.1, evidence: 'Reservations go missing.' }),
    review({ tags: ['booking_friction'], sentiment: 0, evidence: 'Had to call three times to book.' }),
    review({ tags: ['positive_strong_reputation'], sentiment: 1, mentionsOwnerResponse: true }),
    review({ sentiment: 0.5, ownerResponded: true }),
    review({ sentiment: 2, ownerResponded: false, mentionsOwnerResponse: true }),
  ];

  it('counts tags once per review, averages sentiment and keeps a few distinct snippets per tag', () => {
    const contribution = contributionOf(reviews, meta());
    expect(contribution.sampleSize).toBe(8);
    expect(contribution.painCounts).toEqual({
      booking_friction: 5,
      unreachable_by_phone: 1,
      positive_strong_reputation: 1,
    });
    // Sentiments are clamped to [-1, 1]: the 2 counts as 1.
    expect(contribution.sentimentSum).toBeCloseTo(-0.6 - 0.8 - 0.2 + 0.1 + 0 + 1 + 0.5 + 1);
    expect(contribution.evidence.booking_friction?.map((s) => s.text)).toEqual([
      'Booking online is impossible.',
      'Nobody answers calls, so booking fails.',
      'Reservations go missing.',
    ]);
    // The source's word wins over a mention; a mention counts when the source does not tell.
    expect(contribution.ownerResponses).toBe(2);

    const insights = combineInsights({ manual: contribution }, { snapshot: null, trend: 'unknown' }, NOW);
    expect(insights).toMatchObject({
      sources: ['manual'],
      sampleSize: 8,
      painShare: { booking_friction: 0.625, unreachable_by_phone: 0.125, positive_strong_reputation: 0.125 },
      sentimentAvg: 0.125,
      ownerResponseRate: 0.25,
      expiresAt: null,
      model: 'fast-model',
    });
  });

  it('sums sources, prefers the newest evidence and expires a source on its own', () => {
    const google = contributionOf([review({ tags: ['booking_friction'], sentiment: -1, evidence: 'G1' })], {
      ...meta({ source: 'google_places' }),
      computedAt: new Date(NOW.getTime() - DAY),
      expiresAt: new Date(NOW.getTime() + 29 * DAY),
    });
    const manual = contributionOf(
      [
        review({ tags: ['booking_friction'], sentiment: 1, evidence: 'M1' }),
        review({ tags: ['booking_friction'], sentiment: 0, evidence: 'M2' }),
        review({ tags: ['booking_friction'], sentiment: 0, evidence: 'M3' }),
      ],
      meta(),
    );
    const both = combineInsights({ google_places: google, manual }, { snapshot: null, trend: 'flat' }, NOW);
    expect(both?.sources).toEqual(['google_places', 'manual']);
    expect(both?.painCounts.booking_friction).toBe(4);
    expect(both?.evidence.booking_friction?.map((s) => s.text)).toEqual(['M1', 'M2', 'M3']);
    expect(both?.expiresAt).toBe(new Date(NOW.getTime() + 29 * DAY).toISOString());
    expect(both?.ratingTrend).toBe('flat');

    // Expired at its expiry instant exactly.
    const atExpiry = new Date(NOW.getTime() + 29 * DAY);
    expect(Object.keys(liveContributions({ google_places: google, manual }, atExpiry))).toEqual(['manual']);
    const later = new Date(NOW.getTime() + 30 * DAY);
    expect(Object.keys(liveContributions({ google_places: google, manual }, later))).toEqual(['manual']);
    const afterExpiry = combineInsights(
      { google_places: google, manual },
      { snapshot: null, trend: 'flat' },
      later,
    );
    expect(afterExpiry?.sources).toEqual(['manual']);
    expect(afterExpiry?.expiresAt).toBeNull();
    expect(
      combineInsights({ google_places: google }, { snapshot: null, trend: 'unknown' }, later),
    ).toBeNull();
  });

  it('has no insights without an analysed review', () => {
    expect(combineInsights({}, { snapshot: null, trend: 'unknown' }, NOW)).toBeNull();
    expect(
      combineInsights({ manual: contributionOf([], meta()) }, { snapshot: null, trend: 'unknown' }, NOW),
    ).toBeNull();
  });
});

describe('ratingSummary', () => {
  const at = (days: number, avg: number, source: RatingObservation['source'] = 'google_places') => ({
    source,
    avg,
    count: 100,
    observedAt: new Date(NOW.getTime() - days * DAY),
  });

  it('is unknown without enough history, and reads up, down or flat otherwise', () => {
    expect(ratingSummary([])).toEqual({ snapshot: null, trend: 'unknown' });
    expect(ratingSummary([at(0, 4.5)]).trend).toBe('unknown');
    expect(ratingSummary([at(10, 4.2), at(0, 4.6)]).trend).toBe('unknown'); // spans < 14 days
    expect(ratingSummary([at(20, 4.2), at(0, 4.3)]).trend).toBe('up');
    expect(ratingSummary([at(20, 4.4), at(0, 4.3)]).trend).toBe('down');
    expect(ratingSummary([at(20, 4.3), at(0, 4.35)]).trend).toBe('flat');
    expect(ratingSummary([at(14, 4.2), at(0, 4.6)]).trend).toBe('up'); // exactly 14 days
    expect(ratingSummary([at(13.9, 4.2), at(0, 4.6)]).trend).toBe('unknown');
  });

  it('follows the most observed source and snapshots the latest observation', () => {
    const summary = ratingSummary([at(25, 4.0), at(20, 4.0), at(1, 4.0), at(0, 4.9, 'golden_record')]);
    expect(summary.trend).toBe('flat');
    expect(summary.snapshot).toEqual({ avg: 4.9, count: 100, observedAt: NOW.toISOString() });
  });
});

describe('resolveGate', () => {
  const facts = { chosen: undefined, acknowledged: false, keyConfigured: false, scraperAllowed: false };

  it('keeps Google off until an owner acknowledges, then needs a key', () => {
    expect(resolveGate('google_places', facts)).toMatchObject({
      effective: 'none',
      blockedBy: 'acknowledgement',
    });
    // A stored choice cannot enable Google without the acknowledgement.
    expect(resolveGate('google_places', { ...facts, chosen: 'transient_insights' }).effective).toBe('none');
    expect(resolveGate('google_places', { ...facts, acknowledged: true })).toMatchObject({
      usage: 'transient_insights',
      effective: 'none',
      blockedBy: 'not_configured',
    });
    expect(resolveGate('google_places', { ...facts, acknowledged: true, keyConfigured: true })).toMatchObject(
      {
        effective: 'transient_insights',
        blockedBy: null,
        retentionDays: 30,
      },
    );
  });

  it('enables the scraper only where the workspace chose it and the scraper itself is allowed', () => {
    expect(resolveGate('gmaps_scraper', facts)).toMatchObject({
      effective: 'none',
      blockedBy: 'not_enabled',
    });
    expect(resolveGate('gmaps_scraper', { ...facts, chosen: 'transient_insights' }).blockedBy).toBe(
      'scraper_gates',
    );
    expect(
      resolveGate('gmaps_scraper', { ...facts, chosen: 'transient_insights', scraperAllowed: true })
        .effective,
    ).toBe('transient_insights');
  });

  it('never goes above the licence and allows manual paste by default', () => {
    expect(resolveGate('gmaps_scraper', { ...facts, chosen: 'store_text', scraperAllowed: true }).usage).toBe(
      'transient_insights',
    );
    expect(resolveGate('manual', facts)).toMatchObject({
      effective: 'transient_insights',
      retentionDays: null,
    });
    expect(resolveGate('manual', { ...facts, chosen: 'none' })).toMatchObject({
      effective: 'none',
      blockedBy: 'not_enabled',
    });
  });
});
