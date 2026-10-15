import { describe, expect, it } from 'vitest';
import { LedgerBudgetGuard, monthStart } from './ai-adapters.ts';
import { maskPersonalData } from './langfuse.ts';

describe('Langfuse masking', () => {
  it('masks emails and phone numbers anywhere in traced values', () => {
    expect(
      maskPersonalData({
        prompt: 'Write to contact@boulangerie.example.test or call +590 590 00 00 01.',
        messages: [{ content: 'Tél. 05 90 00 00 02' }],
        tokens: 1200,
        year: 'Founded 1998',
      }),
    ).toEqual({
      prompt: 'Write to [email] or call [phone].',
      messages: [{ content: 'Tél. [phone]' }],
      tokens: 1200,
      year: 'Founded 1998',
    });
  });
});

describe('LedgerBudgetGuard', () => {
  it('compares month-to-date spend with the limits and caches it briefly', async () => {
    let spent = 5;
    let calls = 0;
    let now = new Date('2026-10-15T10:00:00Z');
    const ledger = {
      spentSince: async (_org: string, from: Date) => {
        calls++;
        expect(from).toEqual(new Date('2026-10-01T00:00:00Z'));
        return spent;
      },
    };
    const guard = new LedgerBudgetGuard(ledger, { softUsd: 10, hardUsd: 20 }, { now: () => now }, 60_000);
    expect(await guard.check('o')).toBe('ok');
    spent = 15;
    expect(await guard.check('o')).toBe('ok'); // cached
    now = new Date('2026-10-15T10:02:00Z');
    expect(await guard.check('o')).toBe('soft');
    spent = 25;
    now = new Date('2026-10-15T10:04:00Z');
    expect(await guard.check('o')).toBe('hard');
    expect(calls).toBe(3);
    expect(monthStart(new Date('2026-12-31T23:59:59Z'))).toEqual(new Date('2026-12-01T00:00:00Z'));
  });
});
