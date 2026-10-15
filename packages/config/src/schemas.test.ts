import { describe, expect, it } from 'vitest';
import { webEnv, webPublicEnv } from './apps/web.ts';
import { APP_SCHEMAS, isAppName } from './registry.ts';
import { describeVariables } from './schema.ts';

const allVariables = Object.values(APP_SCHEMAS).flatMap((schema) => describeVariables(schema));

describe('declared variables', () => {
  it('all have a description', () => {
    expect(allVariables.filter((v) => v.description === '').map((v) => v.name)).toEqual([]);
  });

  it('mark anything that looks like a credential as secret', () => {
    const looksSecret =
      /SECRET|PASSWORD|TOKEN|API_KEY|MASTER_KEY|ACCESS_KEY|DATABASE_URL|VALKEY_URL|SMTP_URL/;
    // Reviewed exceptions: names that match the pattern but hold no credential.
    const notSecret = new Set(['SECRETS_MASTER_KEY_VERSION']);
    expect(
      allVariables
        .filter((v) => looksSecret.test(v.name) && !v.secret && !notSecret.has(v.name))
        .map((v) => v.name),
    ).toEqual([]);
  });
});

describe('webEnv', () => {
  it('exposes only NEXT_PUBLIC_* variables to the browser, none of them secret', () => {
    const publicVars = describeVariables(webPublicEnv);
    expect(publicVars.length).toBeGreaterThan(0);
    for (const v of publicVars) {
      expect(v.name).toMatch(/^NEXT_PUBLIC_/);
      expect(v.secret).toBe(false);
    }
  });

  it('contains no secrets at all (the dashboard talks to the API)', () => {
    expect(describeVariables(webEnv).filter((v) => v.secret)).toEqual([]);
  });
});

describe('fragments', () => {
  const valid = {
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/bf',
    VALKEY_URL: 'redis://127.0.0.1:6379',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_ACCESS_KEY_ID: 'a',
    S3_SECRET_ACCESS_KEY: 'b',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SMTP_URL: 'smtp://127.0.0.1:1025',
    INTEL_SHARED_SECRET: 'y'.repeat(32),
  };

  it('accepts a complete local api environment', () => {
    const env = APP_SCHEMAS.api.parse(valid);
    expect(env).toMatchObject({ API_PORT: 4000, FEATURE_AUTO_SEND: false, FEATURE_CODING_ENGINES: true });
    expect(env.AI_MODEL_OVERRIDES).toEqual({});
  });

  it.each([
    ['DATABASE_URL', 'mysql://u:p@h/d'],
    ['VALKEY_URL', 'http://h:6379'],
    ['SMTP_URL', 'http://h'],
    ['SECRETS_MASTER_KEY', Buffer.alloc(16).toString('base64')],
    ['SECRETS_MASTER_KEY', 'not base64!'],
    ['BETTER_AUTH_SECRET', 'short'],
    ['API_PORT', '70000'],
    ['AI_MODEL_OVERRIDES', '{"task": 1}'],
    ['AI_MODEL_OVERRIDES', 'not json'],
  ])('rejects %s=%s', (name, value) => {
    expect(APP_SCHEMAS.api.safeParse({ ...valid, [name]: value }).success).toBe(false);
  });

  it('parses model overrides', () => {
    const env = APP_SCHEMAS.api.parse({ ...valid, AI_MODEL_OVERRIDES: '{"classify":"model-a"}' });
    expect(env.AI_MODEL_OVERRIDES).toEqual({ classify: 'model-a' });
  });
});

describe('isAppName', () => {
  it('recognises registered apps only', () => {
    expect(isAppName('api')).toBe(true);
    expect(isAppName('toString')).toBe(false);
  });
});
