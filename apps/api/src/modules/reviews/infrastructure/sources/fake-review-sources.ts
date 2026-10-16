import type { Clock } from '@bf/contracts';
import type { ReviewFetch, ReviewFetchContext, ReviewSourceAdapter } from '../../application/ports.ts';

// Review sources for tests and E2E (`FAKE_REVIEWS`; refused in production): fixed, fake reviews (with a fake author
// name the anonymizer must remove). Nothing is fetched. A business named "… No reviews …" has none.

const FAKE_REVIEWS = [
  {
    text: 'Impossible to book online, we had to call three times. Thanks Jordan for sorting it out.',
    rating: 2,
  },
  { text: 'Nobody ever answers the phone, we gave up and went next door.', rating: 1 },
  { text: 'Le site ne marche pas sur mobile et la carte n’est pas en ligne.', rating: 3, language: 'fr' },
  { text: 'Amazing sunset dinner, best fish on the island. Highly recommend!', rating: 5 },
  { text: 'Correct, sans plus.', rating: 3, language: 'fr' },
] as const;

export class FakeReviewSource implements ReviewSourceAdapter {
  constructor(
    readonly source: 'google_places' | 'gmaps_scraper',
    private readonly clock: Clock,
    readonly estimatedCostUsd = 0,
  ) {}

  async fetch({ subject }: ReviewFetchContext): Promise<ReviewFetch> {
    if (/no reviews/i.test(subject.displayName)) return { kind: 'none' };
    return {
      kind: 'reviews',
      batch: {
        source: this.source,
        reviews: FAKE_REVIEWS.map((review) => ({
          ...review,
          ownerResponded: null,
          knownNames: ['Alex Fictif'],
        })),
        rating: { avg: 3.4, count: 42 },
        fetchedAt: this.clock.now(),
        costUsd: this.estimatedCostUsd,
      },
    };
  }
}
