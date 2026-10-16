import {
  type BusinessFacts,
  type Clock,
  type CreateOrgBusinessFactRequest,
  factValueSchema,
  NotFoundError,
  newId,
  type OrgBusinessFact,
  type RegistryFact,
  type RegistryFactKind,
  registryFactId,
  sha256Hex,
  stableJson,
  type UpdateOrgBusinessFactRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import {
  applyOverlay,
  mergeObservations,
  type Observation,
  registryStats,
} from '../domain/facts/registry.ts';
import {
  FACT_OVERLAY_REPOSITORY,
  FACT_SNAPSHOTS,
  FACT_SOURCES_READER,
  type FactOverlayRepository,
  type FactSnapshotStore,
  type FactSourcesReader,
  type StoredOverlayFact,
} from './facts.ports.ts';

// The fact registry of a business for a workspace (BF-040): the global graph's observations merged (one fact per
// value, all provenances counted), the workspace's own statements on top, and snapshots that pin what a generation
// read. Members edit only the overlay; the global graph stays clean.

export interface FactActor {
  readonly organizationId: string;
  readonly userId: string | null;
}

/** A workspace keeps at most this many statements about one business. */
export const MAX_OVERLAY_FACTS = 300;

const overlayRef = (id: string) => `org_business_fact:${id}`;

export const toOrgBusinessFact = (fact: StoredOverlayFact): OrgBusinessFact => ({
  id: fact.id,
  kind: fact.kind,
  value: fact.value,
  locale: fact.locale,
  note: fact.note,
  createdBy: fact.createdBy,
  createdAt: fact.createdAt.toISOString(),
  updatedAt: fact.updatedAt.toISOString(),
});

function checkValue(kind: RegistryFactKind, value: unknown): unknown {
  const parsed = factValueSchema(kind).safeParse(value);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error, `The value is not a valid ${kind} fact.`);
  return parsed.data;
}

@Injectable()
export class FactRegistryService {
  constructor(
    @Inject(FACT_SOURCES_READER) private readonly sources: FactSourcesReader,
    @Inject(FACT_OVERLAY_REPOSITORY) private readonly overlay: FactOverlayRepository,
    @Inject(FACT_SNAPSHOTS) private readonly snapshots: FactSnapshotStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async registry(actor: FactActor, businessId: string): Promise<BusinessFacts> {
    await this.assertTracked(actor.organizationId, businessId);
    const overlay = await this.overlay.list(actor.organizationId, businessId);
    const facts = await this.build(businessId, overlay);
    return { businessId, facts, overlay: overlay.map(toOrgBusinessFact), stats: registryStats(facts) };
  }

  async create(
    actor: FactActor,
    businessId: string,
    request: CreateOrgBusinessFactRequest,
  ): Promise<OrgBusinessFact> {
    await this.assertTracked(actor.organizationId, businessId);
    const value = checkValue(request.kind, request.value);
    if ((await this.overlay.list(actor.organizationId, businessId)).length >= MAX_OVERLAY_FACTS)
      throw new ValidationError(`A workspace keeps at most ${MAX_OVERLAY_FACTS} facts about one business.`);
    const stored = await this.overlay.insert(
      {
        id: newId(),
        organizationId: actor.organizationId,
        businessId,
        kind: request.kind,
        value,
        locale: request.locale ?? null,
        note: request.note || null,
        createdBy: actor.userId,
      },
      this.clock.now(),
    );
    return toOrgBusinessFact(stored);
  }

  async update(
    actor: FactActor,
    businessId: string,
    factId: string,
    request: UpdateOrgBusinessFactRequest,
  ): Promise<OrgBusinessFact> {
    const existing = await this.overlay.get(actor.organizationId, businessId, factId);
    if (!existing) throw new NotFoundError('OrgBusinessFact', factId);
    const changes = {
      ...(request.value !== undefined ? { value: checkValue(existing.kind, request.value) } : {}),
      ...(request.locale !== undefined ? { locale: request.locale } : {}),
      ...(request.note !== undefined ? { note: request.note || null } : {}),
    };
    const updated = await this.overlay.update(actor.organizationId, factId, changes, this.clock.now());
    if (!updated) throw new NotFoundError('OrgBusinessFact', factId);
    return toOrgBusinessFact(updated);
  }

  async remove(actor: FactActor, businessId: string, factId: string): Promise<void> {
    if (!(await this.overlay.remove(actor.organizationId, businessId, factId, this.clock.now())))
      throw new NotFoundError('OrgBusinessFact', factId);
  }

  /** Pins the registry a generation reads (the same facts serve validation and later audits). */
  async snapshot(
    organizationId: string,
    businessId: string,
  ): Promise<{ id: string; contentHash: string; facts: RegistryFact[] }> {
    const facts = await this.build(businessId, await this.overlay.list(organizationId, businessId));
    const contentHash = await sha256Hex(stableJson(facts));
    const id = await this.snapshots.save({
      organizationId,
      businessId,
      contentHash,
      facts,
      stats: registryStats(facts),
    });
    return { id, contentHash, facts };
  }

  private async assertTracked(organizationId: string, businessId: string) {
    if (!(await this.sources.tracked(organizationId, businessId)))
      throw new NotFoundError('Business', businessId);
  }

  private async build(businessId: string, overlay: readonly StoredOverlayFact[]): Promise<RegistryFact[]> {
    // Provider data is untrusted: a value that does not fit its kind (a malformed URL, an hour out of range) is left out.
    const observations = (await this.sources.observations(businessId)).flatMap((observation) => {
      const parsed = factValueSchema(observation.kind).safeParse(observation.value);
      return parsed.success ? [{ ...observation, value: parsed.data }] : [];
    });
    const global = mergeObservations(observations, await idsOf(observations));
    const statements = overlay.flatMap((fact): Observation[] => {
      const parsed = factValueSchema(fact.kind).safeParse(fact.value);
      if (!parsed.success) return []; // written before a schema change: it waits for a member to fix it
      return [
        {
          kind: fact.kind,
          value: parsed.data,
          ...(fact.locale ? { locale: fact.locale } : {}),
          source: 'user',
          sourceRef: overlayRef(fact.id),
          confidence: 1,
          observedAt: fact.updatedAt.toISOString(),
        },
      ];
    });
    const own = mergeObservations(statements, await idsOf(statements));
    return applyOverlay(global, own);
  }
}

/** `registryFactId` is asynchronous (Web Crypto): the ids are computed first, then looked up by the merge. */
async function idsOf(
  items: readonly { kind: RegistryFactKind; value: unknown; sourceRef: string | null }[],
): Promise<(kind: RegistryFactKind, value: unknown, sourceRef: string | null) => string> {
  const key = (kind: RegistryFactKind, value: unknown, sourceRef: string | null) =>
    `${kind}\u0000${stableJson(value)}\u0000${sourceRef ?? ''}`;
  const ids = new Map<string, string>();
  for (const item of items) {
    const k = key(item.kind, item.value, item.sourceRef);
    if (!ids.has(k)) ids.set(k, await registryFactId(item.kind, item.value, item.sourceRef));
  }
  return (kind, value, sourceRef) => {
    const id = ids.get(key(kind, value, sourceRef));
    if (!id) throw new Error(`No id computed for a ${kind} fact`);
    return id;
  };
}
