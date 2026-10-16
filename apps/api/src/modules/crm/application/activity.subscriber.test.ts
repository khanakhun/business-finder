import { describe, expect, it, vi } from 'vitest';
import { ActivitySubscriber } from './activity.subscriber.ts';
import type { CrmRepository } from './ports.ts';

// The score timeline entry (BF-031): only a real move of the primary profile's tier is news.
const ORG = '01990000-0000-7000-8000-0000000000a1';
const BUSINESS = '01990000-0000-7000-8000-0000000000c1';

const scored = (payload: Record<string, unknown>, orgId: string | null = ORG) =>
  ({
    id: '01990000-0000-7000-8000-0000000000e1',
    type: 'score.updated',
    orgId,
    actor: { type: 'job', id: 'scoring' },
    occurredAt: '2026-10-14T12:00:00.000Z',
    payload: {
      businessId: BUSINESS,
      profileId: '01990000-0000-7000-8000-00000000b101',
      profileVersion: 1,
      offer: 'new_website',
      score: 12,
      tier: 'X',
      previousScore: 55,
      previousTier: 'B',
      primary: true,
      ...payload,
    },
  }) as never;

function setup() {
  const repository = { insertActivity: vi.fn(async () => true) } as unknown as CrmRepository;
  const realtime = { publish: vi.fn(async () => ({})) };
  return { subscriber: new ActivitySubscriber(repository, realtime as never), repository };
}

describe('score timeline entries', () => {
  it('records a tier move of the primary profile', async () => {
    const { subscriber, repository } = setup();
    await subscriber.scored(scored({}));
    expect(repository.insertActivity).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        organizationId: ORG,
        businessId: BUSINESS,
        type: 'score.updated',
        data: { from: 'B', to: 'X', score: 12, offer: 'new_website' },
        sourceEventId: '01990000-0000-7000-8000-0000000000e1',
      }),
    );
  });

  it.each([
    ['a first score', { previousTier: null, previousScore: null }],
    ['another profile', { primary: false }],
    ['the same tier', { previousTier: 'X' }],
  ])('records nothing for %s', async (_, payload) => {
    const { subscriber, repository } = setup();
    await subscriber.scored(scored(payload));
    expect(repository.insertActivity).not.toHaveBeenCalled();
  });

  it('records nothing without a workspace', async () => {
    const { subscriber, repository } = setup();
    await subscriber.scored(scored({}, null));
    expect(repository.insertActivity).not.toHaveBeenCalled();
  });
});
