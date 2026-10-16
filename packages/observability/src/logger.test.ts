import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { withLogContext } from './log-context.ts';
import { createLogger, hashEmail, redactDeep } from './logger.ts';

const SECRET = 'sup3r-s3cret-value';

function capture(options: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      raw.push(String(chunk));
      lines.push(JSON.parse(String(chunk)));
      callback();
    },
  });
  const logger = createLogger({
    service: 'test',
    level: 'debug',
    destination,
    env: 'test',
    version: '1.2.3',
    ...options,
  });
  return { logger, lines, raw };
}

describe('redaction', () => {
  it('removes credentials from request headers', () => {
    const { logger, raw, lines } = capture();
    logger.info(
      { req: { headers: { authorization: `Bearer ${SECRET}`, cookie: `sid=${SECRET}`, accept: 'json' } } },
      'req',
    );
    expect(raw.join('')).not.toContain(SECRET);
    expect(lines[0]).toMatchObject({
      req: { headers: { authorization: '[redacted]', cookie: '[redacted]', accept: 'json' } },
    });
  });

  it('removes sensitive keys at any depth, including inside arrays', () => {
    const { logger, raw, lines } = capture();
    logger.info(
      {
        provider: { name: 'places', apiKey: SECRET },
        mailboxes: [{ address: 'x', credentials: { password: SECRET, refreshToken: SECRET } }],
        deep: {
          a: { b: { c: { token: SECRET, secret: SECRET, clientSecret: SECRET, accessToken: SECRET } } },
        },
      },
      'nested',
    );
    expect(raw.join('')).not.toContain(SECRET);
    expect(lines[0]).toMatchObject({
      provider: { name: 'places', apiKey: '[redacted]' },
      // `credentials` is itself sensitive: the whole object goes.
      mailboxes: [{ address: 'x', credentials: '[redacted]' }],
      deep: {
        a: {
          b: {
            c: {
              token: '[redacted]',
              secret: '[redacted]',
              clientSecret: '[redacted]',
              accessToken: '[redacted]',
            },
          },
        },
      },
    });
  });

  it('removes email bodies', () => {
    const { logger, raw } = capture();
    logger.info({ body: { html: `<p>${SECRET}</p>`, text: SECRET, subject: 'Hello' } }, 'mail');
    expect(raw.join('')).not.toContain(SECRET);
    expect(raw.join('')).toContain('Hello');
  });

  it('accepts extra paths and keys', () => {
    const { logger, raw } = capture({ redactPaths: ['payload.ssn'], redactKeys: ['iban'] });
    logger.info({ payload: { ssn: SECRET }, bank: [{ iban: SECRET }] }, 'extra');
    expect(raw.join('')).not.toContain(SECRET);
  });

  it('redacts error objects and survives cycles', () => {
    const { logger, raw } = capture();
    const cyclic: Record<string, unknown> = { password: SECRET };
    cyclic.self = cyclic;
    logger.error({ err: Object.assign(new Error('boom'), { password: SECRET }), cyclic }, 'failed');
    expect(raw.join('')).not.toContain(SECRET);
    expect(raw.join('')).toContain('boom');
    expect(raw.join('')).toContain('[circular]');
  });
});

describe('redactDeep', () => {
  it('leaves non-sensitive values and primitives alone', () => {
    const date = new Date(0);
    expect(redactDeep({ a: 1, b: [1, 'x'], c: null, d: date }, new Set(['password']))).toEqual({
      a: 1,
      b: [1, 'x'],
      c: null,
      d: date,
    });
    expect(redactDeep('plain', new Set())).toBe('plain');
  });

  it('matches keys case-insensitively and ignores separators', () => {
    const keys = new Set(['apikey', 'password']);
    expect(redactDeep({ API_KEY: 'x', Api_Key: 'y', PASSWORD: 'z' }, keys)).toEqual({
      API_KEY: '[redacted]',
      Api_Key: '[redacted]',
      PASSWORD: '[redacted]',
    });
  });

  it('stops at a maximum depth', () => {
    let value: Record<string, unknown> = { password: SECRET };
    for (let i = 0; i < 20; i++) value = { next: value };
    expect(JSON.stringify(redactDeep(value, new Set(['password'])))).not.toContain(SECRET);
  });
});

describe('fields', () => {
  it('adds service, env, version and log context', async () => {
    const { logger, lines } = capture();
    await withLogContext({ requestId: 'req-1', orgId: 'org-1' }, async () => {
      await withLogContext({ jobId: 'job-9' }, async () => {
        logger.info('inside');
      });
    });
    logger.info('outside');
    expect(lines[0]).toMatchObject({
      service: 'test',
      env: 'test',
      version: '1.2.3',
      requestId: 'req-1',
      orgId: 'org-1',
      jobId: 'job-9',
      msg: 'inside',
    });
    expect(lines[1]).not.toHaveProperty('requestId');
  });

  it('respects the level', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.info('hidden');
    logger.warn('shown');
    expect(lines.map((l) => l.msg)).toEqual(['shown']);
  });
});

describe('hashEmail', () => {
  it('is stable, normalised and does not contain the address', () => {
    const hash = hashEmail(' Owner@Example.TEST ');
    expect(hash).toBe(hashEmail('owner@example.test'));
    expect(hash).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(hash).not.toContain('owner');
  });

  it('changes with a pepper', () => {
    expect(hashEmail('a@b.test', 'pepper')).not.toBe(hashEmail('a@b.test'));
  });
});
