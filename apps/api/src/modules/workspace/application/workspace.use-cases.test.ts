import {
  ConflictError,
  fixedClock,
  NotFoundError,
  type Permission,
  ROLE_PERMISSIONS,
  type Role,
  ValidationError,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFakeTransactions } from '../../identity/application/testing.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { InMemoryObjectStorage } from '../../platform/storage/object-storage.ts';
import { SecretUnavailableError } from '../domain/errors.ts';
import { AuditLogger } from './audit-logger.ts';
import { ListAuditLogsQuery } from './audit-logs.query.ts';
import { ConnectionTesterRegistry } from './connection-testers.ts';
import { FeatureFlagService } from './feature-flags.service.ts';
import { SecretResolver } from './secret-resolver.ts';
import {
  DeleteSecretCommand,
  ListSecretsQuery,
  PutSecretCommand,
  SecretSummaries,
  TestSecretCommand,
} from './secrets.use-cases.ts';
import { SECRET_CACHE_TTL_MS, SecretsVault } from './secrets-vault.ts';
import { GetSettingsQuery, LogoUseCases, UpdateSettingsCommand } from './settings.use-cases.ts';
import { InMemoryAuditLog, InMemoryOrgSettings, InMemorySecrets, StaticMasterKeys } from './testing.ts';
import { WorkspaceReadiness } from './workspace-readiness.ts';

const ORG = '01990000-0000-7000-8000-0000000000a1';
const OTHER_ORG = '01990000-0000-7000-8000-0000000000b2';
const USER = '01990000-0000-7000-8000-0000000000c3';
const SENTINEL = 'sentinel-secret-9f3a7c1e2b4d6f80';
const GOOGLE_KEY = `AIza${'S'.repeat(31)}9f3a`;
const env = {
  FEATURE_AUTO_SEND: false,
  FEATURE_CODING_ENGINES: true,
  FEATURE_MAPS_SCRAPER: false,
  UNSPLASH_ACCESS_KEY: 'global-unsplash-key',
};

const auth = (role: Role = 'owner', orgId = ORG): AuthContext => ({
  method: 'session',
  userId: USER,
  apiKeyId: null,
  orgId,
  role,
  permissions: ROLE_PERMISSIONS[role],
  crossOrigin: false,
  operator: false,
});
const apiKey = (permissions: Permission[]): AuthContext => ({
  method: 'api_key',
  userId: null,
  apiKeyId: '01990000-0000-7000-8000-0000000000d4',
  orgId: ORG,
  role: null,
  permissions: new Set(permissions),
  crossOrigin: false,
  operator: false,
});
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;

let settings: InMemoryOrgSettings;
let secrets: InMemorySecrets;
let auditLog: InMemoryAuditLog;
let clock: ReturnType<typeof fixedClock>;
let audit: AuditLogger;
let vault: SecretsVault;
let resolver: SecretResolver;
let testers: ConnectionTesterRegistry;

beforeEach(() => {
  useFakeTransactions();
  settings = new InMemoryOrgSettings();
  secrets = new InMemorySecrets();
  auditLog = new InMemoryAuditLog();
  clock = fixedClock('2026-10-15T08:00:00.000Z');
  audit = new AuditLogger(auditLog, clock);
  vault = new SecretsVault(secrets, StaticMasterKeys.single(), clock, logger);
  resolver = new SecretResolver(vault, env);
  testers = new ConnectionTesterRegistry(resolver);
});

describe('settings', () => {
  it('returns defaults before the first save, with outreach not ready', async () => {
    const result = await new GetSettingsQuery(settings, env).execute(auth());
    expect(result).toMatchObject({
      agencyName: null,
      primaryLocale: 'en',
      locales: ['en'],
      timezone: 'UTC',
      hasLogo: false,
      updatedAt: null,
      outreachReadiness: { ready: false, missing: ['agency_name', 'postal_address'] },
    });
    expect(result.features.autoSend).toEqual({ enabled: false, workspaceValue: false, available: false });
  });

  it('updates only the fields sent, merges flags and audits the change', async () => {
    const update = new UpdateSettingsCommand(settings, env, audit);
    await update.execute(auth(), { agencyName: 'Agence SBH', locales: ['fr', 'en'], primaryLocale: 'fr' });
    const result = await update.execute(auth(), {
      timezone: 'America/St_Barthelemy',
      features: { semanticSearch: false },
    });
    expect(result).toMatchObject({
      agencyName: 'Agence SBH',
      primaryLocale: 'fr',
      timezone: 'America/St_Barthelemy',
    });
    expect(result.features.semanticSearch.enabled).toBe(false);
    expect(auditLog.entries.map((e) => e.metadata)).toEqual([
      { changed: ['agencyName', 'locales', 'primaryLocale'] },
      { changed: ['features', 'timezone'], features: { semanticSearch: false } },
    ]);
    expect(auditLog.entries[0]).toMatchObject({
      organizationId: ORG,
      actorType: 'user',
      actorId: USER,
      action: 'settings.updated',
      entityType: 'org_settings',
      entityId: ORG,
    });
  });

  it('keeps the primary language among the workspace languages', async () => {
    const update = new UpdateSettingsCommand(settings, env, audit);
    await expect(update.execute(auth(), { primaryLocale: 'fr' })).rejects.toBeInstanceOf(ValidationError);
    await expect(update.execute(auth(), { locales: ['fr'] })).rejects.toBeInstanceOf(ValidationError);
    expect(auditLog.entries).toEqual([]);
  });

  it('refuses flags the deployment disabled', async () => {
    const update = new UpdateSettingsCommand(settings, env, audit);
    await expect(update.execute(auth(), { features: { autoSend: true } })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('attributes API key changes to the key', async () => {
    await new UpdateSettingsCommand(settings, env, audit).execute(apiKey(['settings:manage']), {
      agencyName: 'X',
    });
    expect(auditLog.entries[0]).toMatchObject({
      actorType: 'api_key',
      actorId: '01990000-0000-7000-8000-0000000000d4',
    });
  });

  it('feature flags and outreach readiness read the stored settings', async () => {
    const flags = new FeatureFlagService(settings, { ...env, FEATURE_AUTO_SEND: true });
    expect(await flags.isEnabled(ORG, 'autoSend')).toBe(false);
    await settings.upsert(ORG, { features: { autoSend: true } });
    expect(await flags.isEnabled(ORG, 'autoSend')).toBe(true);
    expect(await new FeatureFlagService(settings, env).isEnabled(ORG, 'autoSend')).toBe(false);

    const readiness = new WorkspaceReadiness(settings);
    expect((await readiness.forOutreach(OTHER_ORG)).missing).toEqual(['agency_name', 'postal_address']);
    await settings.upsert(ORG, {
      agencyName: 'Agence SBH',
      postalAddress: { line1: '1 rue', city: 'Gustavia', postalCode: '97133', countryCode: 'BL' },
    });
    expect(await readiness.forOutreach(ORG)).toEqual({ ready: true, missing: [] });
  });
});

describe('logo', () => {
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(32),
  ]);
  const owner = auth() as AuthContext & { orgId: string };

  it('stores a validated image under the workspace prefix, replaces and removes it', async () => {
    const storage = new InMemoryObjectStorage();
    const logo = new LogoUseCases(settings, storage, logger, audit);
    await logo.upload(owner, png, 'image/png');
    const [first] = storage.objects.keys();
    expect(first).toMatch(new RegExp(`^orgs/${ORG}/logo/`));
    expect(await logo.get(owner)).toEqual({ body: png, contentType: 'image/png' });

    await logo.upload(owner, png, undefined);
    expect([...storage.objects.keys()]).not.toContain(first);
    await logo.remove(owner);
    expect(storage.objects.size).toBe(0);
    await expect(logo.get(owner)).rejects.toBeInstanceOf(NotFoundError);
    await expect(logo.remove(owner)).rejects.toBeInstanceOf(NotFoundError);
    expect(auditLog.entries.map((e) => e.action)).toEqual([
      'settings.logo_updated',
      'settings.logo_updated',
      'settings.logo_removed',
    ]);
  });

  it('rejects SVG, mismatched types and empty bodies', async () => {
    const logo = new LogoUseCases(settings, new InMemoryObjectStorage(), logger, audit);
    await expect(
      logo.upload(owner, Buffer.from('<svg onload="x()"/>'), 'image/svg+xml'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(logo.upload(owner, png, 'image/jpeg')).rejects.toBeInstanceOf(ValidationError);
    await expect(logo.upload(owner, Buffer.alloc(0), 'image/png')).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('secrets vault', () => {
  it('stores ciphertext only, decrypts just in time and caches for a minute', async () => {
    await vault.put(ORG, 'foursquare', SENTINEL, USER);
    const stored = Buffer.concat(Object.values(secrets.rows[0] ?? {}).filter(Buffer.isBuffer));
    expect(stored.includes(Buffer.from(SENTINEL))).toBe(false);
    expect(secrets.rows[0]?.last4).toBe('6f80');

    expect(await vault.get(ORG, 'foursquare')).toBe(SENTINEL);
    const findSpy = vi.spyOn(secrets, 'find');
    expect(await vault.get(ORG, 'foursquare')).toBe(SENTINEL);
    expect(findSpy).not.toHaveBeenCalled();
    clock.advance(SECRET_CACHE_TTL_MS + 1);
    await vault.get(ORG, 'foursquare');
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(secrets.touches.length).toBeGreaterThanOrEqual(1);
  });

  it('is scoped by workspace', async () => {
    await vault.put(ORG, 'foursquare', SENTINEL, USER);
    expect(await vault.get(OTHER_ORG, 'foursquare')).toBeUndefined();
    expect(await vault.has(OTHER_ORG, 'foursquare')).toBe(false);
  });

  it('drops the cached value when a secret is replaced or deleted', async () => {
    await vault.put(ORG, 'foursquare', SENTINEL, USER);
    await vault.get(ORG, 'foursquare');
    await vault.put(ORG, 'foursquare', 'replacement-value', USER);
    expect(await vault.get(ORG, 'foursquare')).toBe('replacement-value');
    await vault.delete(ORG, 'foursquare');
    expect(await vault.get(ORG, 'foursquare')).toBeUndefined();
  });

  it('fails closed without the master key version, without leaking the value', async () => {
    await vault.put(ORG, 'foursquare', SENTINEL, USER);
    const other = new SecretsVault(secrets, StaticMasterKeys.single(2, 9), clock, logger);
    const error = await other.get(ORG, 'foursquare').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(JSON.stringify((error as SecretUnavailableError).toProblem())).not.toContain(SENTINEL);

    secrets.rows = secrets.rows.map((row) => ({ ...row, authTag: Buffer.alloc(16) }));
    const tampered = new SecretsVault(secrets, StaticMasterKeys.single(), clock, logger);
    await expect(tampered.get(ORG, 'foursquare')).rejects.toMatchObject({
      details: { reason: 'DECRYPTION_FAILED' },
    });
  });

  it('checks the provider format before storing', async () => {
    await expect(vault.put(ORG, 'google_places', 'not-a-google-key', USER)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(secrets.rows).toEqual([]);
  });
});

describe('secret resolver', () => {
  it('prefers the workspace value, then the deployment fallback, else nothing', async () => {
    expect(await resolver.resolve(ORG, 'unsplash')).toEqual({
      value: 'global-unsplash-key',
      source: 'global',
    });
    await vault.put(ORG, 'unsplash', 'workspace-unsplash-key', USER);
    expect(await resolver.resolve(ORG, 'unsplash')).toEqual({
      value: 'workspace-unsplash-key',
      source: 'workspace',
    });
    expect(await resolver.resolve(ORG, 'foursquare')).toBeUndefined();
    expect(resolver.hasGlobal('unsplash')).toBe(true);
    expect(resolver.hasGlobal('foursquare')).toBe(false);
  });
});

describe('secrets API use cases', () => {
  const summaries = () => new SecretSummaries(resolver, testers);

  it('lists every registry entry with metadata only', async () => {
    await new PutSecretCommand(vault, summaries(), audit).execute(auth(), 'google_places', GOOGLE_KEY);
    const { items } = await new ListSecretsQuery(vault, summaries()).execute(auth());
    expect(items.map((i) => i.name)).toContain('anthropic');
    expect(items.find((i) => i.name === 'google_places')).toMatchObject({
      source: 'workspace',
      last4: '9f3a',
    });
    expect(items.find((i) => i.name === 'unsplash')).toMatchObject({ source: 'global', last4: null });
    expect(items.find((i) => i.name === 'foursquare')).toMatchObject({ source: null, testable: false });
    expect(JSON.stringify(items)).not.toContain(GOOGLE_KEY);
  });

  it('audits create, replace and delete without the value', async () => {
    const put = new PutSecretCommand(vault, summaries(), audit);
    await put.execute(auth(), 'foursquare', SENTINEL);
    await put.execute(auth(), 'foursquare', `${SENTINEL}-2`);
    await new DeleteSecretCommand(vault, audit).execute(auth(), 'foursquare');
    await expect(new DeleteSecretCommand(vault, audit).execute(auth(), 'foursquare')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(auditLog.entries.map((e) => e.action)).toEqual([
      'secrets.created',
      'secrets.updated',
      'secrets.deleted',
    ]);
    expect(JSON.stringify(auditLog.entries)).not.toContain(SENTINEL);
  });

  it('runs a registered tester and redacts the secret from its message', async () => {
    testers.register('foursquare', async ({ value }) => ({ ok: false, message: `bad key ${value}` }));
    await vault.put(ORG, 'foursquare', SENTINEL, USER);
    const result = await new TestSecretCommand(testers, clock).execute(auth(), 'foursquare');
    expect(result).toEqual({
      ok: false,
      message: 'bad key [REDACTED]',
      source: 'workspace',
      testedAt: '2026-10-15T08:00:00.000Z',
    });
  });

  it('reports a generic failure when the tester throws, and refuses unknown or unset secrets', async () => {
    testers.register('unsplash', async ({ value }) => {
      throw new Error(`provider said: ${value}`);
    });
    expect(await testers.test(ORG, 'unsplash')).toEqual({
      ok: false,
      message: 'The connection test failed.',
      source: 'global',
    });
    await expect(testers.test(ORG, 'anthropic')).rejects.toBeInstanceOf(NotFoundError);
    testers.register('foursquare', async () => ({ ok: true }));
    await expect(testers.test(ORG, 'foursquare')).rejects.toMatchObject({
      details: { reason: 'SECRET_NOT_SET' },
    });
    expect(() => testers.register('foursquare', async () => ({ ok: true }))).toThrow(/already registered/);
  });
});

describe('audit log', () => {
  it('records the request context, redacts metadata and rejects malformed actions', async () => {
    await audit.record({
      action: 'secrets.updated',
      organizationId: ORG,
      metadata: { value: SENTINEL, name: 'x' },
    });
    expect(auditLog.entries[0]).toMatchObject({
      actorType: 'system',
      actorId: null,
      metadata: { value: '[REDACTED]', name: 'x' },
    });
    await expect(audit.record({ action: 'NotDotted' })).rejects.toThrow();
  });

  it('pages newest first with an opaque cursor, scoped to the workspace', async () => {
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      await audit.record({ action: `settings.updated`, organizationId: ORG, metadata: { i } });
    }
    await audit.record({ action: 'settings.updated', organizationId: OTHER_ORG });
    const query = new ListAuditLogsQuery(auditLog);
    const first = await query.execute(auth(), { limit: 2 });
    expect(first.items.map((e) => e.metadata.i)).toEqual([4, 3]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const all = await query.execute(auth(), { limit: 10 });
    expect(all.items).toHaveLength(5);
    expect(all.nextCursor).toBeNull();
    await expect(query.execute(auth(), { limit: 2, cursor: 'garbage' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
