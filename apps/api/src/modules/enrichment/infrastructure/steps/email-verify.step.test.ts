import { ExternalServiceError, fixedClock, ValidationError } from '@bf/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { EmailContactView } from '../../../business-graph/index.ts';
import type { VerificationOutcome } from '../../application/email-verification.service.ts';
import { fromReacher } from '../../domain/email-verification.ts';
import { StepDeferredError, type StepExecution, StepInterruptedError } from '../../domain/enrichment-step.ts';
import { EmailVerifyStep, MAX_DEFERRALS } from './email-verify.step.ts';

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
const transient = new ExternalServiceError('reacher', 'timed out', {
  details: { reason: 'timeout', retryable: true },
});

function harness(
  emails: string[],
  answers: Record<string, VerificationOutcome | Error>,
  options: { guessing?: boolean; allowed?: boolean; names?: string[]; deferrals?: number } = {},
) {
  const verify = vi.fn(async (_org: string, email: string, _signal: AbortSignal, _options?: object) => {
    const answer = answers[email] ?? verdict('safe');
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const record = vi.fn(async () => true);
  const allows = vi.fn(async () => options.allowed ?? false);
  const step = new EmailVerifyStep({
    contacts: {
      listForBusiness: async () => emails.map(contact),
      personNames: async () => options.names ?? [],
    },
    verification: { verify },
    record: { execute: record },
    patternGuessing: async () => options.guessing ?? false,
    personalAddresses: { allowsPersonalAddresses: allows },
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
    deferrals: options.deferrals ?? 0,
  };
  return { step, verify, record, allows, run: () => step.execute(execution) };
}

describe('EmailVerifyStep', () => {
  it('runs after site_intel (optionally), costs provider money, applies when a site or an address exists', () => {
    const { step } = harness([], {});
    expect(step.dependsOn).toEqual(['site_intel']);
    expect(step.optionalDependencies).toEqual(['site_intel']);
    expect(step.costCategory).toBe('provider');
    expect(step.appliesTo(subject)).toBe(true);
    expect(step.appliesTo({ ...subject, websiteUrl: null })).toBe(true);
    expect(step.appliesTo({ ...subject, websiteUrl: null, emails: [] })).toBe('not_applicable');
    expect(step.inputHash(subject)).not.toBe(step.inputHash({ ...subject, emails: ['other@x.example.com'] }));
  });

  it('budgets for what a crawl can still add when the business has a website', () => {
    const { step } = harness([], {});
    // A site: what is known plus up to 20 a crawl can add (website source cap).
    expect(step.estimateCost({ ...subject, emails: [] })).toBeCloseTo(20 * 0.008);
    expect(step.estimateCost(subject)).toBeCloseTo(21 * 0.008);
    // No site: only the known addresses.
    expect(
      step.estimateCost({ ...subject, websiteUrl: null, emails: ['a@x.example', 'b@x.example'] }),
    ).toBeCloseTo(0.016);
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
    expect(await run()).toMatchObject({
      outputRef: { suppressed: 1, checked: 1, recheckAt: new Date(NOW.getTime() + DAY).toISOString() },
    });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('one address’s permanent failure never stops the others', async () => {
    const { run, record } = harness(['a@one.example.com', 'b@two.example.com'], {
      'a@one.example.com': new ValidationError('bad address'),
    });
    expect(await run()).toMatchObject({ outcome: 'done', outputRef: { failed: 1, checked: 1 } });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('a verifier outage never stops the step: other addresses go on, the failed one is due within the hour', async () => {
    const { run, record } = harness(['a@one.example.com', 'b@two.example.com', 'c@three.example.com'], {
      'a@one.example.com': transient,
      'c@three.example.com': { ...verdict('unknown'), provisional: true } as VerificationOutcome,
    });
    expect(await run()).toMatchObject({
      outcome: 'done',
      outputRef: { retryLater: 2, checked: 2, recheckAt: new Date(NOW.getTime() + 3_600_000).toISOString() },
    });
    // The verified one and the provisional one are recorded (a provisional "unknown" never downgrades).
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('a stop (cancel, shutdown) interrupts with what was already spent (booked by the engine)', async () => {
    const controller = new AbortController();
    const step = harness(['a@one.example.com', 'b@two.example.com'], {
      'a@one.example.com': verdict('safe', 0.008),
    });
    step.verify.mockImplementation(async (_org, email) => {
      if (email === 'b@two.example.com') {
        controller.abort(new Error('cancelled'));
        throw new Error('aborted');
      }
      return verdict('safe', 0.008);
    });
    const error = await step.step
      .execute({
        runId: 'run-1',
        stepRowId: 'step-1',
        organizationId: ORG,
        subject,
        inputHash: 'h',
        dependencies: new Map(),
        signal: controller.signal,
        deferrals: 0,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepInterruptedError);
    expect(error).toMatchObject({ costUsd: 0.008, changedFields: ['contacts'] });
  });

  it('passes what it already spent to the budget check of the next address', async () => {
    const { run, verify } = harness(['a@one.example.com', 'b@two.example.com'], {
      'a@one.example.com': verdict('safe', 0.008),
    });
    await run();
    expect(verify.mock.calls.map((c) => c[3])).toEqual([{ pendingUsd: 0 }, { pendingUsd: 0.008 }]);
  });

  it('checks the other addresses first, then defers once for the busy mail servers', async () => {
    const { run, verify } = harness(['a@busy.example.com', 'b@free.example.com', 'c@busy2.example.com'], {
      'a@busy.example.com': { kind: 'rate_limited', retryAfterMs: 9_000 },
      'b@free.example.com': verdict('safe', 0.008),
      'c@busy2.example.com': { kind: 'rate_limited', retryAfterMs: 4_000 },
    });
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepDeferredError);
    expect(error).toMatchObject({ retryAfterMs: 4_000, costUsd: 0.008, changedFields: ['contacts'] });
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('after the last deferral, finishes with what it could check and asks for a re-check', async () => {
    const { run } = harness(
      ['a@busy.example.com', 'b@free.example.com'],
      { 'a@busy.example.com': { kind: 'rate_limited', retryAfterMs: 9_000 } },
      { deferrals: MAX_DEFERRALS },
    );
    expect(await run()).toMatchObject({
      outcome: 'done',
      outputRef: { rateLimited: 1, checked: 1, recheckAt: new Date(NOW.getTime() + 9_000).toISOString() },
    });
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
    // The mail domain is the site's registrable domain (www.salon-ondine.example.com → example.com).
    const published = 'marie@example.com';

    it('is off by default: no candidate is checked', async () => {
      const { run, verify, allows } = harness([published], {}, { names: ['Marie Curie'], allowed: true });
      await run();
      expect(verify.mock.calls.map((c) => c[1])).toEqual([published]);
      expect(allows).not.toHaveBeenCalled();
    });

    it('never runs where personal addresses may not be contacted (deny-all until BF-049)', async () => {
      const { run, verify } = harness([published], {}, { guessing: true, names: ['Marie Curie'] });
      await run();
      expect(verify.mock.calls.map((c) => c[1])).toEqual([published]);
    });

    it('needs an address the business publishes on that domain', async () => {
      const { run, verify } = harness(
        ['salon@gmail.com'],
        {},
        { guessing: true, allowed: true, names: ['Marie Curie'] },
      );
      await run();
      expect(verify.mock.calls.map((c) => c[1])).toEqual(['salon@gmail.com']);
    });

    it('when allowed, checks uncached candidates and keeps only counts — never addresses', async () => {
      const { run, verify, record } = harness(
        [published],
        { 'marie.curie@example.com': verdict('invalid') },
        { guessing: true, allowed: true, names: ['Marie Curie'] },
      );
      const result = await run();
      expect(verify.mock.calls.map((c) => [c[1], c[3]])).toEqual([
        [published, { pendingUsd: 0 }],
        ['marie.curie@example.com', { cache: false, pendingUsd: 0 }],
        ['m.curie@example.com', { cache: false, pendingUsd: 0 }],
      ]);
      expect(result).toMatchObject({ outputRef: { guessed: 2, guessedValid: 1 } });
      expect(JSON.stringify(result)).not.toContain('curie');
      expect(record).toHaveBeenCalledTimes(1);
    });
  });
});
