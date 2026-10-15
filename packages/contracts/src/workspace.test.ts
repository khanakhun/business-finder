import { describe, expect, it } from 'vitest';
import {
  AuditActionSchema,
  AuditLogQuerySchema,
  FEATURE_FLAGS,
  PostalAddressSchema,
  SECRET_DEFINITIONS,
  SECRET_NAMES,
  UpdateOrgSettingsRequestSchema,
} from './workspace.ts';

describe('workspace settings contracts', () => {
  it('accepts a Saint-Barthélemy address and rejects lower-case or long country codes', () => {
    const address = {
      line1: '1 rue de la République',
      city: 'Gustavia',
      postalCode: '97133',
      countryCode: 'BL',
    };
    expect(PostalAddressSchema.parse(address)).toEqual(address);
    expect(PostalAddressSchema.safeParse({ ...address, countryCode: 'bl' }).success).toBe(false);
    expect(PostalAddressSchema.safeParse({ ...address, countryCode: 'BLM' }).success).toBe(false);
    expect(PostalAddressSchema.safeParse({ ...address, line1: '  ' }).success).toBe(false);
  });

  it('validates time zones, unique locales and http(s) websites on update', () => {
    expect(UpdateOrgSettingsRequestSchema.safeParse({ timezone: 'America/St_Barthelemy' }).success).toBe(
      true,
    );
    expect(UpdateOrgSettingsRequestSchema.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(UpdateOrgSettingsRequestSchema.safeParse({ locales: ['fr', 'fr'] }).success).toBe(false);
    expect(UpdateOrgSettingsRequestSchema.safeParse({ websiteUrl: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(UpdateOrgSettingsRequestSchema.safeParse({ websiteUrl: 'https://agence.example' }).success).toBe(
      true,
    );
    expect(UpdateOrgSettingsRequestSchema.safeParse({ features: { autoSend: true } }).success).toBe(true);
    expect(UpdateOrgSettingsRequestSchema.safeParse({ features: { teleport: true } }).success).toBe(false);
  });

  it('defines every feature flag with a boolean default', () => {
    for (const flag of Object.values(FEATURE_FLAGS)) expect(typeof flag.default).toBe('boolean');
  });
});

describe('secret registry', () => {
  it('uses snake_case names and compilable patterns', () => {
    for (const name of SECRET_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      const definition: { validatePattern?: string; globalEnv?: string } = SECRET_DEFINITIONS[name];
      if (definition.validatePattern)
        expect(() => new RegExp(definition.validatePattern as string)).not.toThrow();
      if (definition.globalEnv) expect(definition.globalEnv).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('recognises the expected key formats (fake values)', () => {
    const google = new RegExp(SECRET_DEFINITIONS.google_places.validatePattern);
    expect(google.test(`AIza${'x'.repeat(35)}`)).toBe(true);
    expect(google.test('sk-ant-wrong-provider')).toBe(false);
  });
});

describe('audit log contracts', () => {
  it('requires dotted lower-case actions', () => {
    expect(AuditActionSchema.safeParse('secrets.updated').success).toBe(true);
    expect(AuditActionSchema.safeParse('identity.member_invited').success).toBe(true);
    expect(AuditActionSchema.safeParse('secrets').success).toBe(false);
    expect(AuditActionSchema.safeParse('Secrets.Updated').success).toBe(false);
  });

  it('coerces the page size and validates filters', () => {
    expect(AuditLogQuerySchema.parse({ limit: '20', action: 'secrets.' })).toMatchObject({ limit: 20 });
    expect(AuditLogQuerySchema.safeParse({ action: "x' OR 1=1" }).success).toBe(false);
    expect(AuditLogQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
  });
});
