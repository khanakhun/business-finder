import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Clock, fixedClock, ValidationError } from '@bf/contracts';
import type { DbClient } from '@bf/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransactionalDb } from '../../platform/db/transactional.ts';
import type { EventRecorder } from '../../platform/events/event-recorder.ts';
import {
  NoActivePublicationError,
  SiteArchivedError,
  SiteSpecInvalidError,
  SiteVersionConflictError,
} from '../domain/errors.ts';
import type { SiteRevalidation } from './ports.ts';
import { SiteCommands } from './sites.commands.ts';
import { SiteQueries } from './sites.queries.ts';
import { checkSpec } from './spec-check.ts';
import { InMemorySitesRepository } from './testing.ts';

const fixtures = join(
  dirname(createRequire(import.meta.url).resolve('@bf/site-schema/package.json')),
  'fixtures',
);
const salon = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtures, 'salon-gustavia.json'), 'utf8'));
const hosting = { baseDomain: 'sites.test', assetHosts: ['assets.bf-sites.test'] };
const ORG = '0199e0a0-0000-7000-8000-000000000001';
const OTHER = '0199e0a0-0000-7000-8000-000000000002';
const USER = '0199e0a0-0000-7000-8000-0000000000aa';
const actor = { organizationId: ORG, userId: USER };

const fakeDb = { transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as unknown as DbClient;
beforeAll(() => setTransactionalDb(fakeDb));
afterAll(() => setTransactionalDb(undefined));

let repository: InMemorySitesRepository;
let events: { record: ReturnType<typeof vi.fn> };
let revalidation: { revalidate: ReturnType<typeof vi.fn> };
let clock: Clock;
let commands: SiteCommands;
let queries: SiteQueries;

beforeEach(() => {
  repository = new InMemorySitesRepository();
  events = { record: vi.fn(async () => ({})) };
  revalidation = { revalidate: vi.fn(async () => undefined) };
  clock = fixedClock('2026-10-14T12:00:00.000Z');
  commands = new SiteCommands(
    repository,
    revalidation as unknown as SiteRevalidation,
    hosting,
    clock,
    fakeDb,
    events as unknown as EventRecorder,
  );
  queries = new SiteQueries(repository);
});

const eventTypes = () =>
  events.record.mock.calls.map(([definition]) => (definition as { type: string }).type);

async function siteWithVersion() {
  const businessId = repository.addBusiness(ORG, 'Salon Lumière', 'Gustavia');
  const { siteId } = await commands.create(actor, { businessId, spec: salon() });
  const site = await queries.get(ORG, siteId);
  return { siteId, businessId, v1: site.currentVersion?.id as string };
}

describe('checkSpec', () => {
  it('returns the parsed spec and its warnings', () => {
    const { spec, warnings } = checkSpec(salon(), hosting);
    expect(spec.schemaVersion).toBe(1);
    expect(warnings.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('refuses errors with their codes, an unknown version and a non-spec', () => {
    const bad = salon();
    (bad.seo as { title: Record<string, string> }).title.en = 'www.evil.example';
    expect(() => checkSpec(bad, hosting)).toThrow(SiteSpecInvalidError);
    try {
      checkSpec({ ...salon(), schemaVersion: 99 }, hosting);
    } catch (error) {
      expect((error as ValidationError).errors).toEqual([
        expect.objectContaining({ path: ['schemaVersion'], code: 'future_version' }),
      ]);
    }
    expect(() => checkSpec('not a spec', hosting)).toThrow(SiteSpecInvalidError);
    expect(() => checkSpec(salon(), { ...hosting, assetHosts: ['other.cdn'] })).toThrow(SiteSpecInvalidError);
  });
});

describe('SiteCommands', () => {
  it('creates a site with a first version, idempotently per business, and refuses an untracked business', async () => {
    const { siteId, businessId, v1 } = await siteWithVersion();
    expect(eventTypes()).toEqual(['site.created', 'site.version.created']);
    expect(await commands.create(actor, { businessId })).toEqual({ siteId, created: false });
    const forced = await commands.create(actor, { businessId, forceNew: true });
    expect(forced.created).toBe(true);
    expect((await queries.get(ORG, forced.siteId)).slug).toBe('salon-lumiere-gustavia-2');
    expect(v1).toBeTruthy();
    await expect(commands.create({ ...actor, organizationId: OTHER }, { businessId })).rejects.toThrow(
      /not found/,
    );
  });

  it('gives up when every slug candidate is taken', async () => {
    const businessId = repository.addBusiness(ORG, 'Taken', null);
    vi.spyOn(repository, 'insertSite').mockResolvedValue(false);
    await expect(commands.create(actor, { businessId })).rejects.toThrow(ValidationError);
  });

  it('saves versions from the current one only, with a summary of the changes', async () => {
    const { siteId, v1 } = await siteWithVersion();
    const spec = salon();
    (spec.theme as { radius: string }).radius = 'full';
    const v2 = await commands.createVersion(actor, siteId, { spec, baseVersionId: v1 });
    expect(v2).toMatchObject({ versionNumber: 2, parentVersionId: v1, changeSummary: 'theme updated' });
    await expect(commands.createVersion(actor, siteId, { spec, baseVersionId: v1 })).rejects.toBeInstanceOf(
      SiteVersionConflictError,
    );
    const authored = await commands.createVersion(
      actor,
      siteId,
      { spec, baseVersionId: v2.id, changeSummary: 'From the generator' },
      { type: 'generation_job', id: 'job-1' },
    );
    expect(authored).toMatchObject({
      authorType: 'generation_job',
      authorId: 'job-1',
      changeSummary: 'From the generator',
    });
  });

  it('starts an empty site’s history from a null base', async () => {
    const businessId = repository.addBusiness(ORG, 'Empty', null);
    const { siteId } = await commands.create(actor, { businessId });
    const first = await commands.createVersion(actor, siteId, { spec: salon(), baseVersionId: null });
    expect(first).toMatchObject({ versionNumber: 1, parentVersionId: null, changeSummary: 'First version' });
  });

  it('applies operations atomically and turns a refused operation into a 422', async () => {
    const { siteId, v1 } = await siteWithVersion();
    const v2 = await commands.applyOperations(actor, siteId, {
      baseVersionId: v1,
      operations: [
        { op: 'setTheme', theme: { ...(salon().theme as object), radius: 'lg' } },
        { op: 'removePage', pageId: 'services' },
      ],
    });
    expect(v2.changeSummary).toMatch(/1 page removed/);
    await expect(
      commands.applyOperations(actor, siteId, {
        baseVersionId: v2.id,
        operations: [{ op: 'removePage', pageId: 'nowhere' }],
      }),
    ).rejects.toMatchObject({ errors: [expect.objectContaining({ code: 'page_not_found' })] });
    await expect(
      commands.applyOperations(actor, siteId, { baseVersionId: v2.id, operations: [{ op: 'unknown' }] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('publishes, extends, replaces, unpublishes and asks the renderer to refresh after each', async () => {
    const { siteId, v1 } = await siteWithVersion();
    const preview = await commands.publishPreview(actor, siteId, { versionId: v1, expiresInDays: 30 });
    expect(preview).toMatchObject({
      hostname: 'salon-lumiere-gustavia.sites.test',
      expiresAt: new Date('2026-11-13T12:00:00.000Z'),
    });
    expect((await queries.get(ORG, siteId)).status).toBe('preview');
    expect(revalidation.revalidate).toHaveBeenCalledWith(
      expect.objectContaining({ tags: [`site:${siteId}`, 'host:salon-lumiere-gustavia.sites.test'] }),
    );
    const extended = await commands.extendPreview(actor, siteId, 10);
    expect(extended.expiresAt).toEqual(new Date('2026-11-23T12:00:00.000Z'));
    const again = await commands.publishPreview(actor, siteId, { versionId: v1, expiresInDays: 1 });
    expect(repository.publications.get(preview.id)?.status).toBe('unpublished');
    expect(again.status).toBe('active');
    await commands.unpublish(actor, siteId, 'preview');
    expect((await queries.get(ORG, siteId)).status).toBe('draft');
    await expect(commands.unpublish(actor, siteId, 'preview')).rejects.toBeInstanceOf(
      NoActivePublicationError,
    );
    await expect(commands.extendPreview(actor, siteId, 1)).rejects.toBeInstanceOf(NoActivePublicationError);
    await expect(
      commands.publishPreview(actor, siteId, { versionId: siteId, expiresInDays: 1 }),
    ).rejects.toThrow(/not found/);
    expect(eventTypes()).toEqual(expect.arrayContaining(['site.published', 'site.unpublished']));
  });

  it('expires due previews only (an extended one is kept)', async () => {
    const { siteId, v1 } = await siteWithVersion();
    const preview = await commands.publishPreview(actor, siteId, { versionId: v1, expiresInDays: 1 });
    expect(await commands.expireDuePreviews()).toBe(0);
    await repository.setPublicationExpiry(preview.id, new Date('2026-10-14T00:00:00.000Z'));
    expect(await commands.expireDuePreviews()).toBe(1);
    expect(repository.publications.get(preview.id)).toMatchObject({ status: 'expired' });
    expect(eventTypes()).toContain('site.expired');
  });

  it('rolls back to an earlier version and archives (no further change)', async () => {
    const { siteId, v1 } = await siteWithVersion();
    const v2 = await commands.applyOperations(actor, siteId, {
      baseVersionId: v1,
      operations: [{ op: 'setTheme', theme: { ...(salon().theme as object), radius: 'none' } }],
    });
    const back = await commands.rollback(actor, siteId, { versionId: v1, baseVersionId: v2.id });
    expect(back).toMatchObject({
      authorType: 'rollback',
      changeSummary: 'Rollback to version 1',
      versionNumber: 3,
    });
    await expect(
      commands.rollback(actor, siteId, { versionId: siteId, baseVersionId: back.id }),
    ).rejects.toThrow(/not found/);
    await commands.publishPreview(actor, siteId, { versionId: back.id, expiresInDays: 5 });
    await commands.archive(actor, siteId);
    await commands.archive(actor, siteId);
    expect((await queries.get(ORG, siteId)).status).toBe('archived');
    expect(await repository.activePublications(siteId)).toEqual([]);
    await expect(
      commands.publishPreview(actor, siteId, { versionId: back.id, expiresInDays: 1 }),
    ).rejects.toBeInstanceOf(SiteArchivedError);
    await expect(commands.extendPreview(actor, siteId, 1)).rejects.toBeInstanceOf(SiteArchivedError);
    await expect(
      commands.createVersion(actor, siteId, { spec: salon(), baseVersionId: back.id }),
    ).rejects.toBeInstanceOf(SiteArchivedError);
    expect(eventTypes()).toContain('site.archived');
  });

  it('answers 404 for another workspace’s site', async () => {
    const { siteId } = await siteWithVersion();
    const outsider = { organizationId: OTHER, userId: USER };
    await expect(commands.unpublish(outsider, siteId, 'preview')).rejects.toThrow(/not found/);
    await expect(queries.get(OTHER, siteId)).rejects.toThrow(/not found/);
  });
});

describe('SiteQueries', () => {
  it('lists sites newest first by pages, with filters', async () => {
    for (const name of ['Un', 'Deux', 'Trois'])
      await commands.create(actor, { businessId: repository.addBusiness(ORG, name) });
    const first = await queries.list(ORG, { limit: 2 });
    expect(first.items.map((site) => site.name)).toEqual(['Trois', 'Deux']);
    const next = await queries.list(ORG, { limit: 2, cursor: first.nextCursor ?? '' });
    expect(next.items.map((site) => site.name)).toEqual(['Un']);
    expect(next.nextCursor).toBeNull();
    expect((await queries.list(ORG, { limit: 10, status: 'preview' })).items).toEqual([]);
    expect((await queries.list(OTHER, { limit: 10 })).items).toEqual([]);
    await expect(queries.list(ORG, { limit: 2, cursor: 'garbage' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('pages versions, reads one and diffs two', async () => {
    const { siteId, v1 } = await siteWithVersion();
    const v2 = await commands.applyOperations(actor, siteId, {
      baseVersionId: v1,
      operations: [{ op: 'setTheme', theme: { ...(salon().theme as object), radius: 'full' } }],
    });
    const page = await queries.versions(ORG, siteId, { limit: 1 });
    expect(page.items.map((v) => v.versionNumber)).toEqual([2]);
    const rest = await queries.versions(ORG, siteId, { limit: 1, cursor: page.nextCursor ?? '' });
    expect(rest.items.map((v) => v.versionNumber)).toEqual([1]);
    expect((await queries.version(ORG, siteId, v2.id)).spec).toMatchObject({ schemaVersion: 1 });
    await expect(queries.version(ORG, siteId, siteId)).rejects.toThrow(/not found/);
    expect(await queries.diff(ORG, siteId, v1, v2.id)).toMatchObject({
      from: v1,
      to: v2.id,
      sections: ['theme'],
    });
    await expect(queries.diff(ORG, siteId, v1, siteId)).rejects.toThrow(/not found/);
    await expect(queries.diff(ORG, siteId, siteId, v1)).rejects.toThrow(/not found/);
    await expect(queries.versions(ORG, siteId, { limit: 1, cursor: 'garbage' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
