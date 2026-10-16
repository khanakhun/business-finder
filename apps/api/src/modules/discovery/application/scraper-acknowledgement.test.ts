import { ConflictError, ForbiddenError, SCRAPER_WARNING_VERSION } from '@bf/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../platform/config/app-env.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import type { AuditLogger, AuditTrail, FeatureFlagService } from '../../workspace/index.ts';
import { SCRAPER_ACKNOWLEDGED, SCRAPER_REVOKED, ScraperAcknowledgement } from './scraper-acknowledgement.ts';

type Entry = { action: string; warningVersion?: number | undefined };

const owner: AuthContext = {
  method: 'session',
  userId: 'user-1',
  apiKeyId: null,
  orgId: 'org-1',
  role: 'owner',
  permissions: new Set(['settings:manage']),
  crossOrigin: false,
  operator: false,
};

function setup(entries: Entry[], options: { flag?: boolean; deployed?: boolean } = {}) {
  const trail = {
    latest: vi.fn(async () => {
      const entry = entries.at(-1);
      return entry
        ? {
            action: entry.action,
            actorId: 'user-1',
            occurredAt: new Date('2026-10-15T12:00:00Z'),
            metadata: { warningVersion: entry.warningVersion },
          }
        : undefined;
    }),
  } as unknown as AuditTrail;
  const audit = {
    record: vi.fn(async (e: { action: string; metadata?: { warningVersion?: number } }) => {
      entries.push({ action: e.action, warningVersion: e.metadata?.warningVersion });
    }),
  } as unknown as AuditLogger;
  const flags = { isEnabled: vi.fn(async () => options.flag ?? true) } as unknown as FeatureFlagService;
  const env = {
    FEATURE_MAPS_SCRAPER: options.deployed ?? true,
    MAPS_SCRAPER_URL: 'http://scraper.test',
  } as unknown as AppEnv;
  return { service: new ScraperAcknowledgement(trail, audit, flags, env), audit };
}

describe('ScraperAcknowledgement', () => {
  it('lets the latest acknowledge/revoke entry win', async () => {
    const entries: Entry[] = [];
    const { service } = setup(entries);
    expect(await service.allowed('org-1')).toBe(false);
    await service.acknowledge(owner, SCRAPER_WARNING_VERSION);
    expect(await service.allowed('org-1')).toBe(true);
    await service.revoke(owner);
    expect(entries.map((e) => e.action)).toEqual([SCRAPER_ACKNOWLEDGED, SCRAPER_REVOKED]);
    expect(await service.allowed('org-1')).toBe(false);
    await service.acknowledge(owner, SCRAPER_WARNING_VERSION);
    expect(await service.allowed('org-1')).toBe(true);
  });

  it('ignores an acknowledgement of an older warning and needs the workspace flag', async () => {
    expect(
      await setup([
        { action: SCRAPER_ACKNOWLEDGED, warningVersion: SCRAPER_WARNING_VERSION - 1 },
      ]).service.allowed('org-1'),
    ).toBe(false);
    const flagged = setup([{ action: SCRAPER_ACKNOWLEDGED, warningVersion: SCRAPER_WARNING_VERSION }], {
      flag: false,
    });
    expect(await flagged.service.isAcknowledged('org-1')).toBe(true);
    expect(await flagged.service.allowed('org-1')).toBe(false);
  });

  it('accepts only a signed-in owner, the current warning and a deployed scraper', async () => {
    const { service } = setup([]);
    await expect(
      service.acknowledge({ ...owner, role: 'admin' }, SCRAPER_WARNING_VERSION),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.acknowledge(
        { ...owner, method: 'api_key', userId: null, apiKeyId: 'k' },
        SCRAPER_WARNING_VERSION,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.acknowledge(owner, SCRAPER_WARNING_VERSION + 1)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      setup([], { deployed: false }).service.acknowledge(owner, SCRAPER_WARNING_VERSION),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
