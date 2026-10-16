import {
  DoNotContactSet,
  decodeCursor,
  encodeCursor,
  ForbiddenError,
  type MergeBusinessesRequest,
  type MergeBusinessesResult,
  NotFoundError,
  newId,
  type PossibleDuplicatePage,
  type PossibleDuplicateQuery,
  type ResolvePossibleDuplicateRequest,
  type SplitBusinessRequest,
  type SplitBusinessResult,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Transactional } from '../../../platform/db/transactional.ts';
import { EventRecorder } from '../../../platform/events/event-recorder.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { AuditLogger } from '../../../workspace/index.ts';
import { BusinessMergedError } from '../../domain/errors.ts';
import { blockingLockKeys, businessLockKeys } from '../../domain/resolution/blocking.ts';
import { BUSINESS_REPOSITORY, type BusinessRepository } from '../ports.ts';
import { recordEvents } from '../record-events.ts';
import { workspaceOf } from '../workspace-of.ts';
import { GoldenRecordWriter } from './golden-record.writer.ts';
import {
  MERGE_REPOSITORY,
  type MergeRepository,
  RESOLUTION_REPOSITORY,
  type ResolutionRepository,
} from './ports.ts';

/** The workspace may only act on businesses it tracks (404 otherwise: untracked ids are not revealed). */
async function assertTracked(
  merges: MergeRepository,
  auth: AuthContext,
  ids: readonly string[],
): Promise<void> {
  const tracked = await merges.trackedBy(workspaceOf(auth), ids);
  const missing = ids.find((id) => !tracked.has(id));
  if (missing) throw new NotFoundError('Business', missing);
}

/**
 * Merging or splitting rewrites global facts and other workspaces' links: only allowed when no other workspace
 * tracks the businesses involved, unless a platform operator does it (ADR-0008 governance). Checked under the locks.
 */
async function assertNotShared(
  merges: MergeRepository,
  auth: AuthContext,
  ids: readonly string[],
): Promise<void> {
  if (auth.operator) return;
  const shared = await merges.trackedByOthers(workspaceOf(auth), ids);
  if (shared.size > 0) {
    throw new ForbiddenError(
      'Other workspaces track these businesses: a platform operator must merge or split them.',
      {
        details: { reason: 'BUSINESS_SHARED' },
      },
    );
  }
}

/**
 * Lock protocol (blocking.ts): phase 1, the blocking keys of every source involved — so no ingestion creates a
 * business that this merge/split is about to change — then phase 2, the businesses.
 */
async function lockForMerge(resolution: ResolutionRepository, businessIds: readonly string[]): Promise<void> {
  const keys = new Set<string>();
  for (const id of businessIds) {
    for (const source of await resolution.listLinkedSources(id)) {
      for (const key of blockingLockKeys(source.normalized)) keys.add(key);
    }
  }
  await resolution.lockKeys([...keys].sort());
  await resolution.lockKeys(businessLockKeys(businessIds));
}

/**
 * Merges businesses into a survivor (BF-016): sources, contacts, media, reviews, workspace links and duplicate
 * pairs move to the survivor, which is recomputed from all its sources; the others become read-only
 * (`merged_into_id`) and emit `business.merged`.
 */
@Injectable()
export class MergeBusinessesCommand {
  constructor(
    @Inject(BUSINESS_REPOSITORY) private readonly businesses: BusinessRepository,
    @Inject(MERGE_REPOSITORY) private readonly merges: MergeRepository,
    @Inject(RESOLUTION_REPOSITORY) private readonly resolution: ResolutionRepository,
    private readonly writer: GoldenRecordWriter,
    private readonly events: EventRecorder,
    private readonly audit: AuditLogger,
  ) {}

  @Transactional()
  async execute(auth: AuthContext, request: MergeBusinessesRequest): Promise<MergeBusinessesResult> {
    const ids = [request.survivorId, ...request.mergedIds];
    await assertTracked(this.merges, auth, ids);
    await lockForMerge(this.resolution, ids);
    await assertNotShared(this.merges, auth, ids);
    const loaded = await this.businesses.getByIds(ids);
    for (const id of ids) {
      const business = loaded.find((b) => b.id === id);
      if (!business) throw new NotFoundError('Business', id);
      const { mergedIntoId } = business.snapshot();
      if (mergedIntoId) throw new BusinessMergedError(id, mergedIntoId);
    }
    // Every workspace link involved, locked once in order (one pair at a time would break the order, BF-031).
    await this.merges.lockOrgLinks(ids);
    let sourcesMoved = 0;
    for (const mergedId of request.mergedIds) {
      sourcesMoved += await this.merges.moveSources(mergedId, request.survivorId);
      await this.merges.moveSideData(mergedId, request.survivorId);
      // Do-not-contact carried over by the merge is a new suppression for those workspaces (compliance, BF-049).
      for (const { organizationId, reason } of await this.merges.mergeOrgLinks(
        mergedId,
        request.survivorId,
      )) {
        await this.events.record(DoNotContactSet, {
          orgId: organizationId,
          payload: { businessId: request.survivorId as never, doNotContact: true, reason },
        });
      }
      await this.merges.repointDuplicates(mergedId, request.survivorId);
      const merged = loaded.find((b) => b.id === mergedId);
      if (!merged) continue;
      merged.markMerged(request.survivorId);
      await this.businesses.save(merged);
      await recordEvents(this.events, merged);
      await this.audit.record({
        action: 'business.merged_into',
        entityType: 'business',
        entityId: mergedId,
        metadata: { survivorId: request.survivorId },
      });
    }
    const sources = await this.resolution.listLinkedSources(request.survivorId);
    if (sources.length > 0) {
      await this.writer.write(
        request.survivorId,
        sources.map((s) => s.normalized),
        { create: false },
      );
    }
    await this.audit.record({
      action: 'business.merged',
      entityType: 'business',
      entityId: request.survivorId,
      metadata: { mergedIds: request.mergedIds, sourcesMoved },
    });
    return { survivorId: request.survivorId, mergedIds: request.mergedIds, sourcesMoved };
  }
}

/** Moves the given sources to a new business (unmerge) and recomputes both (BF-016). */
@Injectable()
export class SplitBusinessCommand {
  constructor(
    @Inject(BUSINESS_REPOSITORY) private readonly businesses: BusinessRepository,
    @Inject(MERGE_REPOSITORY) private readonly merges: MergeRepository,
    @Inject(RESOLUTION_REPOSITORY) private readonly resolution: ResolutionRepository,
    private readonly writer: GoldenRecordWriter,
    private readonly audit: AuditLogger,
  ) {}

  @Transactional()
  async execute(
    auth: AuthContext,
    businessId: string,
    request: SplitBusinessRequest,
  ): Promise<SplitBusinessResult> {
    await assertTracked(this.merges, auth, [businessId]);
    await lockForMerge(this.resolution, [businessId]);
    await assertNotShared(this.merges, auth, [businessId]);
    const business = await this.businesses.getById(businessId);
    if (!business) throw new NotFoundError('Business', businessId);
    const { mergedIntoId } = business.snapshot();
    if (mergedIntoId) throw new BusinessMergedError(businessId, mergedIntoId);

    const sources = await this.merges.listSources(businessId);
    const moving = new Set(request.sourceIds);
    const unknown = request.sourceIds.find((id) => !sources.some((s) => s.id === id));
    if (unknown) {
      throw new ValidationError('A source does not belong to this business.', [
        { path: ['sourceIds'], message: `Unknown source ${unknown}` },
      ]);
    }
    const remaining = sources.filter((s) => !moving.has(s.id));
    const moved = sources.filter((s) => moving.has(s.id));
    if (!remaining.some((s) => s.hasNormalized) || !moved.some((s) => s.hasNormalized)) {
      throw new ValidationError('Both businesses need at least one source after a split.', [
        { path: ['sourceIds'], message: 'Leave at least one source on each side' },
      ]);
    }

    const newBusinessId = newId();
    const all = await this.resolution.listLinkedSources(businessId);
    await this.writer.write(
      newBusinessId,
      all.filter((s) => moving.has(s.id)).map((s) => s.normalized),
      { create: true },
    );
    const sourcesMoved = await this.merges.moveSources(businessId, newBusinessId, request.sourceIds);
    await this.merges.copyOrgLinks(businessId, newBusinessId);
    await this.writer.write(
      businessId,
      all.filter((s) => !moving.has(s.id)).map((s) => s.normalized),
      { create: false },
    );
    await this.audit.record({
      action: 'business.split',
      entityType: 'business',
      entityId: businessId,
      metadata: { newBusinessId, sourcesMoved },
    });
    return {
      businessId: businessId as SplitBusinessResult['businessId'],
      newBusinessId: newBusinessId as SplitBusinessResult['newBusinessId'],
      sourcesMoved,
    };
  }
}

const CREATED_AT = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Possible duplicates among businesses the workspace tracks (both of each pair), newest first. */
@Injectable()
export class ListPossibleDuplicatesQuery {
  constructor(@Inject(MERGE_REPOSITORY) private readonly merges: MergeRepository) {}

  async execute(auth: AuthContext, query: PossibleDuplicateQuery): Promise<PossibleDuplicatePage> {
    let before: { createdAt: string; id: string } | undefined;
    if (query.cursor) {
      const data = await decodeCursor(query.cursor);
      const [at] = data.sort;
      const year = typeof at === 'string' ? Number(CREATED_AT.exec(at)?.[1]) : Number.NaN;
      if (typeof at !== 'string' || !(year >= 2000 && year <= 2100) || !z.uuid().safeParse(data.id).success) {
        throw new ValidationError('Invalid cursor.', [{ path: ['cursor'], message: 'Invalid cursor' }]);
      }
      before = { createdAt: at, id: data.id };
    }
    const rows = await this.merges.listDuplicates({
      organizationId: workspaceOf(auth),
      status: query.status,
      ...(query.businessId ? { businessId: query.businessId } : {}),
      limit: query.limit + 1,
      ...(before ? { before } : {}),
    });
    const page = rows.slice(0, query.limit);
    const labels = await this.merges.businessLabels(page.flatMap((r) => [r.businessAId, r.businessBId]));
    const label = (id: string) => ({
      id: id as PossibleDuplicatePage['items'][number]['businessA']['id'],
      displayName: labels.get(id)?.displayName ?? '',
      locality: labels.get(id)?.locality ?? null,
    });
    const last = page.at(-1);
    return {
      items: page.map((r) => ({
        id: r.id,
        businessA: label(r.businessAId),
        businessB: label(r.businessBId),
        score: r.score,
        reasons: r.reasons,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last
          ? await encodeCursor({ sort: [last.createdAtText], id: last.id })
          : null,
    };
  }
}

/** Dismiss a possible duplicate, or merge its pair (B into A unless `survivorId` says otherwise). */
@Injectable()
export class ResolvePossibleDuplicateCommand {
  constructor(
    @Inject(MERGE_REPOSITORY) private readonly merges: MergeRepository,
    private readonly merge: MergeBusinessesCommand,
    private readonly audit: AuditLogger,
  ) {}

  @Transactional()
  async execute(auth: AuthContext, id: string, request: ResolvePossibleDuplicateRequest): Promise<void> {
    const pair = await this.merges.getDuplicate(id);
    if (!pair) throw new NotFoundError('PossibleDuplicate', id);
    // Same visibility as the list: both businesses tracked.
    const tracked = await this.merges.trackedBy(workspaceOf(auth), [pair.businessAId, pair.businessBId]);
    if (!tracked.has(pair.businessAId) || !tracked.has(pair.businessBId))
      throw new NotFoundError('PossibleDuplicate', id);
    if (pair.status !== 'open') {
      throw new ValidationError('This pair was already resolved.', [
        { path: ['action'], message: pair.status },
      ]);
    }
    if (request.action === 'dismiss') {
      await this.merges.setDuplicateStatus(id, 'dismissed');
      await this.audit.record({
        action: 'business.duplicate_dismissed',
        entityType: 'possible_duplicate',
        entityId: id,
      });
      return;
    }
    const survivorId = request.survivorId ?? pair.businessAId;
    if (survivorId !== pair.businessAId && survivorId !== pair.businessBId) {
      throw new ValidationError('The survivor must be one of the pair.', [
        { path: ['survivorId'], message: 'Not in pair' },
      ]);
    }
    const mergedId = survivorId === pair.businessAId ? pair.businessBId : pair.businessAId;
    type Id = MergeBusinessesRequest['survivorId'];
    await this.merge.execute(auth, { survivorId: survivorId as Id, mergedIds: [mergedId as Id] });
    await this.merges.setDuplicateStatus(id, 'merged');
  }
}
