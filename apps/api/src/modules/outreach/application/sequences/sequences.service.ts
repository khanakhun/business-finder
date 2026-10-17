import {
  NotFoundError,
  newId,
  type SaveSequenceRequest,
  SaveSequenceRequestSchema,
  type Sequence,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '../../../platform/db/transactional.ts';
import { validateDefinition } from '../../domain/sequences/sequence-definition.ts';
import type { DraftActor } from '../drafting/drafts.service.ts';
import { SEQUENCE_REPOSITORY, type SequenceRecord, type SequenceRepository } from './ports.ts';

// Sequence definitions (BF-053): created as drafts, activated when the safety rails hold, archived when no longer
// used. Saving a sequence writes its next immutable version; running enrollments stay on theirs.

@Injectable()
export class SequencesService {
  constructor(@Inject(SEQUENCE_REPOSITORY) private readonly repository: SequenceRepository) {}

  async list(actor: DraftActor): Promise<Sequence[]> {
    const rows = await this.repository.list(actor.organizationId);
    return Promise.all(rows.map((row) => this.view(row)));
  }

  async get(actor: DraftActor, id: string): Promise<Sequence> {
    return this.view(await this.load(actor, id));
  }

  @Transactional()
  async create(actor: DraftActor, input: SaveSequenceRequest): Promise<Sequence> {
    const request = this.validated(input);
    const id = newId();
    await this.repository.insert(
      {
        id,
        organizationId: actor.organizationId,
        name: request.name,
        offer: request.offer,
        status: 'draft',
        headVersion: 1,
      },
      { id: newId(), sequenceId: id, version: 1, settings: request.settings, steps: request.steps },
      actor.userId,
    );
    return this.get(actor, id);
  }

  /** A new version (the previous ones stay for the enrollments that use them). */
  @Transactional()
  async update(actor: DraftActor, id: string, input: SaveSequenceRequest): Promise<Sequence> {
    const request = this.validated(input);
    const sequence = await this.load(actor, id);
    if (sequence.status === 'archived')
      throw new ValidationError('An archived sequence cannot change.', [], {
        details: { reason: 'ARCHIVED' },
      });
    const version = sequence.headVersion + 1;
    await this.repository.insertVersion(
      { id: newId(), sequenceId: id, version, settings: request.settings, steps: request.steps },
      actor.userId,
    );
    await this.repository.update(actor.organizationId, id, {
      name: request.name,
      offer: request.offer,
      headVersion: version,
    });
    return this.get(actor, id);
  }

  async activate(actor: DraftActor, id: string): Promise<Sequence> {
    const sequence = await this.load(actor, id);
    const head = await this.repository.version(id, sequence.headVersion);
    if (!head) throw new NotFoundError('SequenceVersion', `${id}@${sequence.headVersion}`);
    this.assertValid(head.settings, head.steps);
    await this.repository.update(actor.organizationId, id, { status: 'active' });
    return this.get(actor, id);
  }

  async archive(actor: DraftActor, id: string): Promise<Sequence> {
    await this.load(actor, id);
    await this.repository.update(actor.organizationId, id, { status: 'archived' });
    return this.get(actor, id);
  }

  private validated(input: SaveSequenceRequest) {
    const request = SaveSequenceRequestSchema.parse(input);
    this.assertValid(request.settings, request.steps);
    return request;
  }

  private assertValid(...args: Parameters<typeof validateDefinition>) {
    const issues = validateDefinition(...args);
    if (issues.length > 0)
      throw new ValidationError(
        'The sequence does not respect the safety rails.',
        issues.map((issue) => ({ path: issue.path.split('.'), message: issue.message, code: issue.code })),
        { details: { reason: 'SEQUENCE_INVALID' } },
      );
  }

  private async load(actor: DraftActor, id: string) {
    const sequence = await this.repository.get(actor.organizationId, id);
    if (!sequence) throw new NotFoundError('Sequence', id);
    return sequence;
  }

  private async view(row: SequenceRecord): Promise<Sequence> {
    const head = await this.repository.version(row.id, row.headVersion);
    const counts = await this.repository.activeEnrollmentCounts([row.id]);
    return {
      id: row.id,
      name: row.name,
      offer: row.offer,
      status: row.status,
      version: row.headVersion,
      versionId: head?.id ?? row.id,
      settings: head?.settings as Sequence['settings'],
      steps: head?.steps ?? [],
      activeEnrollments: counts.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
