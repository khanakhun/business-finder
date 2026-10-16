import { ConflictError, ValidationError } from '@bf/contracts';
import { describe, expect, it } from 'vitest';
import { isSensitiveKey, REDACTED, redactMetadata } from './audit-redaction.ts';
import { assertCanSet, featureState, featureStates, isAvailable } from './feature-flags.ts';
import { outreachReadiness } from './readiness.ts';
import { assertSecretFormat, last4Of } from './secret-values.ts';

describe('feature flags', () => {
  const on = { FEATURE_AUTO_SEND: true, FEATURE_CODING_ENGINES: true, FEATURE_MAPS_SCRAPER: true };
  const off = { FEATURE_AUTO_SEND: false, FEATURE_CODING_ENGINES: false, FEATURE_MAPS_SCRAPER: false };

  // Truth table: deployment switch × workspace choice → effective value.
  it.each([
    [on, true, true],
    [on, false, false],
    [off, true, false],
    [off, false, false],
  ])('deployment %j, workspace %s → %s', (deployment, workspace, expected) => {
    expect(featureState('autoSend', { autoSend: workspace }, deployment).enabled).toBe(expected);
  });

  it('uses the registry default when the workspace never chose', () => {
    expect(featureState('codingEngines', {}, on)).toEqual({
      enabled: true,
      workspaceValue: true,
      available: true,
    });
    expect(featureState('autoSend', {}, on)).toEqual({
      enabled: false,
      workspaceValue: false,
      available: true,
    });
  });

  it('treats flags without a deployment switch as always available', () => {
    expect(isAvailable('semanticSearch', off)).toBe(true);
    expect(isAvailable('mapsScraper', {})).toBe(false);
    expect(Object.keys(featureStates({}, off)).sort()).toEqual([
      'autoSend',
      'codingEngines',
      'emailPatternGuessing',
      'mapsScraper',
      'semanticSearch',
    ]);
  });

  it('refuses enabling a deployment-disabled flag, but allows disabling it', () => {
    expect(() => assertCanSet({ autoSend: true }, off)).toThrow(ConflictError);
    expect(() => assertCanSet({ autoSend: false, semanticSearch: true }, off)).not.toThrow();
    try {
      assertCanSet({ autoSend: true, mapsScraper: true }, off);
    } catch (error) {
      expect((error as ConflictError).details).toEqual({
        reason: 'FEATURE_UNAVAILABLE',
        flags: ['autoSend', 'mapsScraper'],
      });
    }
  });
});

describe('outreach readiness', () => {
  const address = { line1: '1 rue', city: 'Gustavia', postalCode: '97133', countryCode: 'BL' };

  it('reports missing agency name and postal address', () => {
    expect(outreachReadiness({ agencyName: null, postalAddress: null })).toEqual({
      ready: false,
      missing: ['agency_name', 'postal_address'],
    });
    expect(outreachReadiness({ agencyName: '  ', postalAddress: address })).toEqual({
      ready: false,
      missing: ['agency_name'],
    });
    expect(outreachReadiness({ agencyName: 'Agence SBH', postalAddress: address })).toEqual({
      ready: true,
      missing: [],
    });
  });
});

describe('audit metadata redaction', () => {
  it.each(['value', 'apiKey', 'api_key', 'password', 'accessToken', 'Authorization', 'clientSecret', 'key'])(
    'redacts %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
      expect(redactMetadata({ [key]: 'sentinel-value' })).toEqual({ [key]: REDACTED });
    },
  );

  it.each(['name', 'apiKeyId', 'role', 'keyVersion', 'changed', 'last4'])('keeps %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('redacts nested keys and bounds depth, size and string length', () => {
    const redacted = redactMetadata({
      provider: { token: 'sentinel', nested: { a: { b: { c: 'deep' } } } },
      list: Array.from({ length: 60 }, (_, i) => i),
      long: 'x'.repeat(600),
      when: new Date('2026-10-15T00:00:00Z'),
      fn: () => 1,
    });
    expect(JSON.stringify(redacted)).not.toContain('sentinel');
    expect(redacted.provider).toEqual({ token: REDACTED, nested: { a: { b: '[TRUNCATED]' } } });
    expect(redacted.list).toHaveLength(50);
    expect(String(redacted.long)).toHaveLength(501);
    expect(redacted.when).toBe('2026-10-15T00:00:00.000Z');
    expect(redacted.fn).toBeNull();
  });
});

describe('secret values', () => {
  it('shows last4 only for long values', () => {
    expect(last4Of('short-secret')).toBeNull();
    expect(last4Of('a-long-enough-secret-1234')).toBe('1234');
  });

  it('checks the provider format without echoing the value', () => {
    expect(() => assertSecretFormat('google_places', `AIza${'k'.repeat(35)}`)).not.toThrow();
    expect(() => assertSecretFormat('foursquare', 'anything goes')).not.toThrow();
    try {
      assertSecretFormat('google_places', 'sk-ant-sentinel-value');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(JSON.stringify((error as ValidationError).toProblem())).not.toContain('sentinel');
      expect((error as ValidationError).toProblem().reason).toBe('SECRET_FORMAT');
    }
  });
});
