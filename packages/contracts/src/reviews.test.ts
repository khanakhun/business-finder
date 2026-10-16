import { describe, expect, it } from 'vitest';
import {
  AnalyzePastedReviewsRequestSchema,
  evidenceProblem,
  narrowerUsage,
  PAIN_SIGNAL_DEFINITIONS,
  PAIN_SIGNAL_TAGS,
  REVIEW_SOURCE_LICENSING,
  REVIEW_SOURCES,
  reviewWords,
} from './reviews.ts';
import { PAIN_SIGNALS } from './search-intent.ts';

describe('pain-signal taxonomy', () => {
  it('defines every tag in both languages, and search filters use the same ids', () => {
    expect(PAIN_SIGNALS).toBe(PAIN_SIGNAL_TAGS);
    for (const tag of PAIN_SIGNAL_TAGS) {
      const definition = PAIN_SIGNAL_DEFINITIONS[tag];
      expect(definition.label.en && definition.label.fr).toBeTruthy();
      expect(definition.description.en && definition.description.fr).toBeTruthy();
    }
    expect(PAIN_SIGNAL_DEFINITIONS.positive_strong_reputation.polarity).toBe('positive');
    expect(PAIN_SIGNAL_DEFINITIONS.other.offers).toEqual([]);
  });
});

describe('review licensing', () => {
  it('never lets a workspace choice exceed what the source allows', () => {
    expect(narrowerUsage('store_text', 'transient_insights')).toBe('transient_insights');
    expect(narrowerUsage('none', 'store_text')).toBe('none');
    expect(narrowerUsage('transient_insights', 'transient_insights')).toBe('transient_insights');
  });

  it('keeps Google and the scraper off by default, and never stores their text', () => {
    for (const source of REVIEW_SOURCES)
      expect(REVIEW_SOURCE_LICENSING[source].maxUsage).not.toBe('store_text');
    expect(REVIEW_SOURCE_LICENSING.google_places.defaultUsage).toBe('none');
    expect(REVIEW_SOURCE_LICENSING.google_places.requires).toBe('owner_acknowledgement');
    expect(REVIEW_SOURCE_LICENSING.gmaps_scraper.defaultUsage).toBe('none');
    expect(REVIEW_SOURCE_LICENSING.manual.defaultUsage).toBe('transient_insights');
  });
});

describe('evidenceProblem', () => {
  const review = 'We called five times and nobody ever picked up the phone, so we booked somewhere else.';

  it('accepts a short paraphrase', () => {
    expect(evidenceProblem('Calls go unanswered; the customer booked elsewhere.', review)).toBeNull();
  });

  it('refuses quotes of five or more consecutive words, whatever the case and punctuation', () => {
    expect(evidenceProblem('Nobody ever picked up the phone.', review)).toBe('quote');
    expect(evidenceProblem('NOBODY, ever picked-up the', review)).toBe('quote');
    // Four shared words in a row are allowed.
    expect(evidenceProblem('Nobody ever picked up; they went elsewhere.', review)).toBeNull();
  });

  it('refuses a short snippet copied whole from a short review', () => {
    expect(evidenceProblem('Impossible de réserver.', 'Impossible de réserver.')).toBe('quote');
    expect(evidenceProblem('Top', 'Top !')).toBe('quote');
    expect(evidenceProblem('Booking is hard', 'Impossible de réserver.')).toBeNull();
  });

  it('accepts exactly twenty words', () => {
    expect(evidenceProblem(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '), review)).toBeNull();
  });

  it('refuses snippets over twenty words or empty ones', () => {
    expect(evidenceProblem(Array.from({ length: 21 }, (_, i) => `w${i}`).join(' '), review)).toBe('too_long');
    expect(evidenceProblem(' … ', review)).toBe('too_long');
  });

  it('refuses snippets that still carry personal details', () => {
    expect(evidenceProblem('Ask [person] for a table.', review)).toBe('personal');
    expect(evidenceProblem('Write to @lavague for bookings.', review)).toBe('personal');
    expect(evidenceProblem('Call 0590000000 to book.', review)).toBe('personal');
  });

  it('splits words on Unicode letters', () => {
    expect(reviewWords("Très bon, l'accueil était top !")).toEqual([
      'très',
      'bon',
      'l',
      'accueil',
      'était',
      'top',
    ]);
  });
});

describe('AnalyzePastedReviewsRequestSchema', () => {
  it('bounds the paste and trims texts', () => {
    expect(AnalyzePastedReviewsRequestSchema.parse({ reviews: [{ text: '  Top  ' }] }).reviews[0]?.text).toBe(
      'Top',
    );
    expect(AnalyzePastedReviewsRequestSchema.safeParse({ reviews: [] }).success).toBe(false);
    expect(
      AnalyzePastedReviewsRequestSchema.safeParse({
        reviews: Array.from({ length: 51 }, () => ({ text: 'x' })),
      }).success,
    ).toBe(false);
    expect(AnalyzePastedReviewsRequestSchema.safeParse({ reviews: [{ text: '   ' }] }).success).toBe(false);
  });
});
