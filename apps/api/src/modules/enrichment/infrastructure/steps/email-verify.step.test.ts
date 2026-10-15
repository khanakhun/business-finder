import { fixedClock } from '@bf/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { VerificationOutcome } from '../../application/email-verification.service.ts';
import type { EmailContactView } from '../../application/ports.ts';
import { fromReacher } from '../../domain/email-verification.ts';
import { StepDeferredError, type StepExecution } from '../../domain/enrichment-step.ts';
import { EmailVerifyStep } from './email-verify.step.ts';

const BIZ = '00000000-0000-7000-8000-000000000b01';
const ORG = '00000000-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const DAY = 24 * 3_600_000;

const subject = {
  businessId: BIZ,
  displayName: 'Salon Ondine',
  websiteUrl: 'https://www.salon-ondine.example.com/',
  countryCode: 'BL',
  locales: ['fr'],
  emails: ['info@salon-ondine.example.com'],
};
const contact = (email: string): EmailContactView => ({
  id: `id-${email}`,
  businessId: BIZ,
  email,
  verificationStatus: 'unknown',
  verifiedAt: null,
});
const verdict = (reachable: string, costUsd = 0, expiresInDays = 60): VerificationOutcome => ({
  kind: 'verdict',
  check: fromReacher({ is_reachable: reachable }),
  checkedAt: NOW,
  expiresAt: new Date(NOW.getTime() + expiresInDays * DAY),
  cached: false,
  costUsd,
});

function harness(
  emails: string[],
  answers: Record<string, VerificationOutcome>,
  options: { guessing?: boolean; names?: string[] } = {},
) {
  const verify = vi.fn(async (_org: string, email: string) => answers[email] ?? verdict('safe'));
  const record = vi.fn(async () => true);
  const step = new EmailVerifyStep({
    contacts: {
      listForBusiness: async () => emails.map(contact),
      find: async () => undefined,
      personNames: async () => options.names ?? [],
    },
    verification: { verify },
    record: { execute: record },
    patternGuessing: async () => options.guessing ?? false,
    clock: fixedClock(NOW),
    ttlDays: 60,
    unitCostUsd: 0.008,
  });
  const execution: StepExecution = {
    runId: 'run-1',
    stepRowId: 'step-1',
    organizationId: ORG,
    subject,
    inputHash: 'h',
    dependencies: new Map(),
    signal: new AbortController().signal,
  };
  return { step, verify, record, run: () => step.execute(execution) };
}

describe('EmailVerifyStep', () => {
  it('depends on site_intel, costs provider money, applies when a site or an address exists', () => {
    const { step } = harness([], {});
    expect(step.dependsOn).toEqual(['site_intel']);
    expect(step.costCategory).toBe('provider');
    expect(step.appliesTo(subject)).toBe(true);
    expect(step.appliesTo({ ...subject, websiteUrl: null })).toBe(true);
    expect(step.appliesTo({ ...subject, websiteUrl: null, emails: [] })).toBe('not_applicable');
    expect(step.estimateCost({ ...subject, emails: ['a@x.example.com', 'b@x.example.com'] })).toBeCloseTo(
      0.016,
    );
    expect(step.inputHash(subject)).not.toBe(step.inputHash({ ...subject, emails: ['other@x.example.com'] }));
  });

  it('records every verdict on its contact and adds up the cost', async () => {
    const { run, record } = harness(['info@salon-ondine.example.com', 'compta@salon-ondine.example.com'], {
      'compta@salon-ondine.example.com': verdict('invalid', 0.008),
    });
    const result = await run();
    expect(result).toMatchObject({
      outcome: 'done',
      costUsd: 0.008,
      changedFields: ['contacts'],
      outputRef: { checked: 2, cached: 0, statuses: { valid: 1, invalid: 1 }, recheckAt: null },
    });
    expect(record).toHaveBeenCalledWith(BIZ, 'compta@salon-ondine.example.com', {
      status: 'invalid',
      details: expect.objectContaining({ checkedVia: 'reacher' }),
      verifiedAt: NOW,
    });
  });

  it('reports no change when the verdicts were already recorded', async () => {
    const { run, record } = harness(['info@salon-ondine.example.com'], {});
    record.mockResolvedValue(false);
    expect(await run()).toMatchObject({ outcome: 'done', changedFields: [] });
  });

  it('skips suppressed addresses and asks to re-check inconclusive ones when their entry expires', async () => {
    const { run, record } = harness(['stop@salon-ondine.example.com', 'resa@salon-ondine.example.com'], {
      'stop@salon-ondine.example.com': { kind: 'suppressed' },
      'resa@salon-ondine.example.com': verdict('unknown', 0, 1),
    });
    const result = await run();
    expect(result).toMatchObject({
      outputRef: { suppressed: 1, checked: 1, recheckAt: new Date(NOW.getTime() + DAY).toISOString() },
    });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('defers itself when a recipient domain must wait, keeping the cost and changes so far', async () => {
    const { run } = harness(['a@one.example.com', 'b@two.example.com'], {
      'a@one.example.com': verdict('safe', 0.008),
      'b@two.example.com': { kind: 'rate_limited', retryAfterMs: 9_000 },
    });
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepDeferredError);
    expect(error).toMatchObject({ retryAfterMs: 9_000, costUsd: 0.008, changedFields: ['contacts'] });
  });

  it('is not applicable when the site gave no address', async () => {
    const { run } = harness([], {});
    expect(await run()).toEqual({ outcome: 'skipped', reason: 'not_applicable', costUsd: 0 });
  });

  it('is stale at the re-check time of an inconclusive verdict, else after the TTL', () => {
    const { step } = harness([], {});
    const finishedAt = new Date(NOW.getTime() - 3 * DAY);
    const last = (recheckAt: string | null) => ({ finishedAt, inputHash: 'h', outputRef: { recheckAt } });
    expect(step.isStale(last(new Date(NOW.getTime() - 1).toISOString()), NOW)).toBe(true);
    expect(step.isStale(last(new Date(NOW.getTime() + DAY).toISOString()), NOW)).toBe(false);
    expect(step.isStale(last(null), NOW)).toBe(false);
    expect(step.isStale(last(null), new Date(finishedAt.getTime() + 60 * DAY))).toBe(true);
  });

  describe('pattern guessing', () => {
    it('is off by default: no candidate is checked', async () => {
      const { run, verify } = harness(['info@salon-ondine.example.com'], {}, { names: ['Marie Curie'] });
      await run();
      expect(verify.mock.calls.map((c) => c[1])).toEqual(['info@salon-ondine.example.com']);
    });

    it('when on, checks candidates on the site’s domain and reports only valid ones — never as contacts', async () => {
      const { run, verify, record } = harness(
        ['marie@example.com'],
        { 'marie.curie@example.com': verdict('invalid') },
        { guessing: true, names: ['Marie Curie'] },
      );
      // The mail domain is the site's registrable domain (www.example.com → example.com).
      const result = await run();
      expect(verify.mock.calls.map((c) => c[1])).toEqual([
        'marie@example.com',
        'marie.curie@example.com',
        'm.curie@example.com',
      ]);
      expect(result).toMatchObject({
        outputRef: { guessed: [{ email: 'm.curie@example.com', status: 'valid' }] },
      });
      // Only the known contact is recorded.
      expect(record).toHaveBeenCalledTimes(1);
    });
  });
});
