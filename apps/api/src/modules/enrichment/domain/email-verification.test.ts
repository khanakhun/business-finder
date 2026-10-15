import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  chainOrder,
  disposableByClassification,
  fromDns,
  fromReacher,
  fromZeroBounce,
  guessEmailCandidates,
  isConclusive,
  mailProviderFromMx,
  verdictTtlDays,
  withClassification,
} from './email-verification.ts';

// Contract tests: recorded-shape (synthetic, fake domains) Reacher and ZeroBounce answers → verdicts.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../infrastructure/__fixtures__/email/${name}`, import.meta.url), 'utf8'));

describe('fromReacher', () => {
  it.each([
    ['reacher-safe.json', 'valid', 'safe'],
    ['reacher-invalid.json', 'invalid', 'invalid'],
    ['reacher-catch-all.json', 'catch_all', 'risky'],
    ['reacher-timeout.json', 'unknown', 'unknown'],
  ])('%s → %s', (name, status, reachable) => {
    const check = fromReacher(fixture(name));
    expect(check.status).toBe(status);
    expect(check.details.reachable).toBe(reachable);
    expect(check.details.checkedVia).toBe('reacher');
    expect(check.costUsd).toBe(0);
  });

  it('keeps what Reacher saw', () => {
    expect(fromReacher(fixture('reacher-safe.json')).details).toEqual({
      reachable: 'safe',
      isCatchAll: false,
      isDisposable: false,
      isRoleAccount: true,
      mxAcceptsMail: true,
      smtpCanConnect: true,
      provider: 'Google',
      checkedVia: 'reacher',
    });
    expect(fromReacher(fixture('reacher-catch-all.json')).details).toMatchObject({
      isCatchAll: true,
      provider: 'Microsoft',
    });
  });

  it('reads failed sections (error objects) as unknown facts', () => {
    expect(fromReacher(fixture('reacher-timeout.json')).details).toMatchObject({
      isCatchAll: null,
      smtpCanConnect: null,
      mxAcceptsMail: true,
    });
  });

  it('refines risky: disposable, then catch-all, else risky (role accounts)', () => {
    const risky = (misc: object, smtp: object) => fromReacher({ is_reachable: 'risky', misc, smtp }).status;
    expect(risky({ is_disposable: true }, { is_catch_all: true })).toBe('disposable');
    expect(risky({ is_disposable: false }, { is_catch_all: true })).toBe('catch_all');
    expect(risky({ is_role_account: true }, { is_catch_all: false })).toBe('risky');
  });

  it('treats anything unexpected as unknown', () => {
    expect(fromReacher({ is_reachable: 'maybe' }).status).toBe('unknown');
    expect(fromReacher(null).status).toBe('unknown');
    expect(fromReacher({ is_reachable: 'safe', mx: { records: 'nope' } }).details.provider).toBeNull();
  });
});

describe('fromZeroBounce', () => {
  it('valid: billed, with the provider ZeroBounce names', () => {
    const check = fromZeroBounce(fixture('zerobounce-valid.json'), 0.008);
    expect(check).toMatchObject({ status: 'valid', costUsd: 0.008 });
    expect(check.details).toEqual({
      reachable: 'safe',
      isCatchAll: false,
      isDisposable: false,
      isRoleAccount: false,
      mxAcceptsMail: true,
      smtpCanConnect: null,
      provider: 'g-suite',
      checkedVia: 'zerobounce',
    });
  });

  it('greylisted: unknown, inconclusive and not billed', () => {
    const check = fromZeroBounce(fixture('zerobounce-greylisted.json'), 0.008);
    expect(check).toMatchObject({ status: 'unknown', costUsd: 0 });
    expect(isConclusive(check)).toBe(false);
  });

  it('do_not_mail/disposable → disposable', () => {
    expect(fromZeroBounce(fixture('zerobounce-disposable.json'), 0.008)).toMatchObject({
      status: 'disposable',
      details: { isDisposable: true, reachable: 'risky' },
    });
  });

  it.each([
    ['invalid', '', 'invalid'],
    ['catch-all', '', 'catch_all'],
    ['spamtrap', '', 'invalid'],
    ['abuse', '', 'risky'],
    ['do_not_mail', 'role_based', 'risky'],
    ['do_not_mail', 'toxic', 'risky'],
    ['something_new', '', 'unknown'],
  ])('%s/%s → %s', (status, subStatus, expected) => {
    const check = fromZeroBounce({ status, sub_status: subStatus }, 0.01);
    expect(check.status).toBe(expected);
    expect(check.details.mxAcceptsMail).toBeNull();
  });

  it('flags role-based catch-alls', () => {
    expect(
      fromZeroBounce({ status: 'do_not_mail', sub_status: 'role_based_catch_all' }, 0).details,
    ).toMatchObject({ isRoleAccount: true, isCatchAll: true });
  });
});

describe('fromDns', () => {
  it('a domain that cannot receive mail makes the address invalid', () => {
    expect(fromDns({ mx: [], nullMx: true, hasAddress: true })).toMatchObject({
      status: 'invalid',
      details: { mxAcceptsMail: false, checkedVia: 'dns' },
    });
    expect(fromDns({ mx: [], nullMx: false, hasAddress: false }).status).toBe('invalid');
  });

  it('otherwise says nothing about the mailbox', () => {
    expect(fromDns({ mx: ['aspmx.l.google.com.'], nullMx: false, hasAddress: false })).toMatchObject({
      status: 'unknown',
      details: { mxAcceptsMail: true, provider: 'Google', reachable: 'unknown' },
    });
    // RFC 5321 §5.1: no MX but an address record is an implicit MX.
    expect(fromDns({ mx: [], nullMx: false, hasAddress: true }).details.mxAcceptsMail).toBe(true);
  });
});

describe('classification over verifiers', () => {
  it('a disposable domain is disposable without a check', () => {
    expect(disposableByClassification(false)).toMatchObject({
      status: 'disposable',
      costUsd: 0,
      details: { checkedVia: 'classification', isDisposable: true },
    });
  });

  it('overrides a verifier that missed it, but never an invalid verdict', () => {
    const valid = fromReacher(fixture('reacher-safe.json'));
    expect(withClassification(valid, true).status).toBe('disposable');
    expect(withClassification(valid, false)).toBe(valid);
    const invalid = fromReacher(fixture('reacher-invalid.json'));
    expect(withClassification(invalid, true).status).toBe('invalid');
  });
});

describe('verdictTtlDays', () => {
  it('trusts conclusive verdicts (including a permanent invalid) for the whole TTL', () => {
    expect(verdictTtlDays({ status: 'valid' }, 0, 60)).toBe(60);
    expect(verdictTtlDays({ status: 'invalid' }, 0, 60)).toBe(60);
  });

  it('backs off on inconclusive ones: 1, 2, 4… days, capped at the TTL', () => {
    expect([1, 2, 3, 4, 7, 9].map((n) => verdictTtlDays({ status: 'unknown' }, n, 60))).toEqual([
      1, 2, 4, 8, 60, 60,
    ]);
  });
});

describe('chainOrder', () => {
  it('keeps the workspace order, without duplicates or verifiers this deployment lacks', () => {
    const available = new Set(['reacher', 'dns'] as const);
    expect(chainOrder(['zerobounce', 'dns', 'reacher', 'dns'], available)).toEqual(['dns', 'reacher']);
  });
});

describe('mailProviderFromMx', () => {
  it.each([
    [['alt1.aspmx.l.google.com.'], 'Google'],
    [['example-com.mail.protection.outlook.com'], 'Microsoft'],
    [['mx1.mail.ovh.net.'], 'OVHcloud'],
    [['mail.salon.example.com.'], null],
    [[], null],
  ])('%j → %s', (hosts, provider) => {
    expect(mailProviderFromMx(hosts)).toBe(provider);
  });
});

describe('guessEmailCandidates', () => {
  it('first@, first.last@ and f.last@ on the domain, accents folded', () => {
    expect(guessEmailCandidates('Hélène Dupré', 'salon.example.fr')).toEqual([
      'helene@salon.example.fr',
      'helene.dupre@salon.example.fr',
      'h.dupre@salon.example.fr',
    ]);
    expect(guessEmailCandidates('Jean-Marc de la Tour', 'example.com')).toEqual([
      'jean-marc@example.com',
      'jean-marc.tour@example.com',
      'j.tour@example.com',
    ]);
  });

  it('a single name gives first@ only; nothing usable gives nothing', () => {
    expect(guessEmailCandidates('Marie', 'example.com')).toEqual(['marie@example.com']);
    expect(guessEmailCandidates('  ', 'example.com')).toEqual([]);
    expect(guessEmailCandidates('Marie Curie', 'not a domain')).toEqual([]);
  });
});
