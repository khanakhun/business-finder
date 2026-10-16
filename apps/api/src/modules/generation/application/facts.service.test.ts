import { NotFoundError, newId, type RegistryFact, ValidationError } from '@bf/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Observation } from '../domain/facts/registry.ts';
import type {
  FactOverlayRepository,
  FactSnapshotStore,
  FactSourcesReader,
  StoredOverlayFact,
} from './facts.ports.ts';
import { FactRegistryService, MAX_OVERLAY_FACTS } from './facts.service.ts';

const ORG = newId();
const OTHER = newId();
const BUSINESS = newId();
const at = '2026-10-16T12:00:00.000Z';

class Sources implements FactSourcesReader {
  observed: Observation[] = [];
  async tracked(organizationId: string, businessId: string) {
    return organizationId === ORG && businessId === BUSINESS;
  }
  async observations() {
    return this.observed;
  }
}

class Overlay implements FactOverlayRepository {
  rows: (StoredOverlayFact & { deleted?: boolean })[] = [];
  async list(organizationId: string, businessId: string) {
    return this.rows.filter(
      (r) => r.organizationId === organizationId && r.businessId === businessId && !r.deleted,
    );
  }
  async get(organizationId: string, businessId: string, id: string) {
    return (await this.list(organizationId, businessId)).find((r) => r.id === id);
  }
  async insert(fact: Omit<StoredOverlayFact, 'createdAt' | 'updatedAt'>, at: Date) {
    const row = { ...fact, createdAt: at, updatedAt: at };
    this.rows.push(row);
    return row;
  }
  async update(organizationId: string, id: string, changes: Partial<StoredOverlayFact>, at: Date) {
    const index = this.rows.findIndex(
      (r) => r.organizationId === organizationId && r.id === id && !r.deleted,
    );
    const row = this.rows[index];
    if (!row) return undefined;
    this.rows[index] = { ...row, ...changes, updatedAt: at };
    return this.rows[index];
  }
  async remove(organizationId: string, businessId: string, id: string) {
    const row = await this.get(organizationId, businessId, id);
    if (!row) return false;
    (row as { deleted?: boolean }).deleted = true;
    return true;
  }
}

class Snapshots implements FactSnapshotStore {
  readonly byHash = new Map<string, { id: string; facts: readonly RegistryFact[] }>();
  async save(input: Parameters<FactSnapshotStore['save']>[0]) {
    const existing = this.byHash.get(input.contentHash);
    if (existing) return existing.id;
    const id = newId();
    this.byHash.set(input.contentHash, { id, facts: input.facts });
    return id;
  }
  async load(_organizationId: string, id: string) {
    return [...this.byHash.values()].find((s) => s.id === id)?.facts as RegistryFact[] | undefined;
  }
}

const clock = { now: () => new Date(at) };
const actor = { organizationId: ORG, userId: newId() };
let sources: Sources;
let overlay: Overlay;
let snapshots: Snapshots;
let service: FactRegistryService;

beforeEach(() => {
  sources = new Sources();
  overlay = new Overlay();
  snapshots = new Snapshots();
  service = new FactRegistryService(sources, overlay, snapshots, clock);
  sources.observed = [
    {
      kind: 'name',
      value: 'Cafe Gustavia',
      source: 'open_data',
      sourceRef: 'osm:node/1',
      confidence: 0.9,
      observedAt: at,
    },
    {
      kind: 'phone',
      value: '+590590270000',
      source: 'provider_restricted',
      sourceRef: 'g:1',
      confidence: 0.9,
      observedAt: at,
    },
    {
      kind: 'email',
      value: 'hello@cafe.example',
      source: 'owner_site',
      sourceRef: 'https://cafe.example',
      confidence: 0.9,
      observedAt: at,
    },
    // Untrusted provider data that does not fit its kind is left out.
    {
      kind: 'social',
      value: { network: 'instagram', url: 'javascript:alert(1)' },
      source: 'owner_site',
      sourceRef: null,
      confidence: 0.9,
      observedAt: at,
    },
    {
      kind: 'geo',
      value: { lat: 200, lng: 0 },
      source: 'open_data',
      sourceRef: null,
      confidence: 0.9,
      observedAt: at,
    },
  ];
});

describe('FactRegistryService', () => {
  it('builds the registry with stable ids, usage and counts', async () => {
    const registry = await service.registry(actor, BUSINESS);
    expect(registry.facts.map((f) => [f.kind, f.usage])).toEqual([
      ['email', 'display'],
      ['name', 'display'],
      ['phone', 'internal'],
    ]);
    for (const fact of registry.facts)
      expect(fact.id).toMatch(new RegExp(`^fact_${fact.kind}_[0-9a-f]{12}$`));
    expect((await service.registry(actor, BUSINESS)).facts.map((f) => f.id)).toEqual(
      registry.facts.map((f) => f.id),
    );
    expect(registry.stats).toEqual({ display: 2, internal: 1, byKind: { email: 1, name: 1, phone: 1 } });
  });

  it('refuses a business the workspace does not track (404, not 403: its existence is not revealed)', async () => {
    await expect(service.registry({ organizationId: OTHER, userId: null }, BUSINESS)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      service.create({ organizationId: OTHER, userId: null }, BUSINESS, { kind: 'name', value: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets the workspace override a single-valued fact and add others, without touching the global graph', async () => {
    const stated = await service.create(actor, BUSINESS, {
      kind: 'name',
      value: '  Le Café Gustavia ',
      locale: 'fr',
    });
    expect(stated).toMatchObject({
      kind: 'name',
      value: 'Le Café Gustavia',
      locale: 'fr',
      createdBy: actor.userId,
    });
    await service.create(actor, BUSINESS, {
      kind: 'phone',
      value: '+590590270000',
      note: 'confirmed by phone',
    });
    const registry = await service.registry(actor, BUSINESS);
    const names = registry.facts.filter((f) => f.kind === 'name');
    expect(names.map((f) => [f.value, f.source, f.usage])).toEqual(
      expect.arrayContaining([
        ['Cafe Gustavia', 'open_data', 'internal'],
        ['Le Café Gustavia', 'user', 'display'],
      ]),
    );
    expect(
      registry.facts
        .filter((f) => f.kind === 'phone')
        .map((f) => f.usage)
        .sort(),
    ).toEqual(['display', 'internal']);
    expect(registry.overlay).toHaveLength(2);
    expect(sources.observed).toHaveLength(5);
  });

  it('validates values by kind', async () => {
    await expect(
      service.create(actor, BUSINESS, { kind: 'year_founded', value: 'long ago' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.create(actor, BUSINESS, {
        kind: 'hours',
        value: { weekly: [{ day: 'mon', opens: '25:00', closes: '18:00' }] },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      service.create(actor, BUSINESS, { kind: 'brand_color', value: '#0a7cff' }),
    ).resolves.toBeDefined();
    await expect(
      service.create(actor, BUSINESS, { kind: 'year_founded', value: 1998 }),
    ).resolves.toBeDefined();
  });

  it('updates and withdraws the workspace’s own facts only', async () => {
    const fact = await service.create(actor, BUSINESS, { kind: 'service', value: 'Brunch' });
    const updated = await service.update(actor, BUSINESS, fact.id, {
      value: 'Brunch du dimanche',
      note: null,
    });
    expect(updated).toMatchObject({ value: 'Brunch du dimanche', note: null });
    await expect(service.update(actor, BUSINESS, fact.id, { value: '' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      service.update({ organizationId: OTHER, userId: null }, BUSINESS, fact.id, { value: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.remove({ organizationId: OTHER, userId: null }, BUSINESS, fact.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    await service.remove(actor, BUSINESS, fact.id);
    await expect(service.remove(actor, BUSINESS, fact.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await service.registry(actor, BUSINESS)).overlay).toHaveLength(0);
  });

  it('caps the overlay of one business', async () => {
    for (let i = 0; i < MAX_OVERLAY_FACTS; i++)
      overlay.rows.push({
        id: newId(),
        organizationId: ORG,
        businessId: BUSINESS,
        kind: 'amenity',
        value: `Amenity ${i}`,
        locale: null,
        note: null,
        createdBy: null,
        createdAt: new Date(at),
        updatedAt: new Date(at),
      });
    await expect(
      service.create(actor, BUSINESS, { kind: 'amenity', value: 'One more' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('deduplicates snapshots by content and takes a new one when the registry changes', async () => {
    const first = await service.snapshot(ORG, BUSINESS);
    const again = await service.snapshot(ORG, BUSINESS);
    expect(again).toEqual(first);
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await snapshots.load(ORG, first.id)).toEqual(first.facts);
    await service.create(actor, BUSINESS, { kind: 'tagline', value: 'Le meilleur brunch de Gustavia' });
    const changed = await service.snapshot(ORG, BUSINESS);
    expect(changed.id).not.toBe(first.id);
    expect(changed.facts.some((f) => f.kind === 'tagline' && f.source === 'user')).toBe(true);
  });
});
