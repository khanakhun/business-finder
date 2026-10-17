import {
  ConflictError,
  NotFoundError,
  type SetShadowModelRequest,
  SetShadowModelRequestSchema,
  type ShadowAssignment,
  type ShadowScore,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { SCORING_REPOSITORY, type ScoringRepository } from '../ports.ts';
import { RecomputeProfileCommand } from '../scoring.use-cases.ts';
import type { MlActor } from './dataset-builder.ts';
import { MODEL_REGISTRY, type ModelRegistry, SHADOW_REPOSITORY, type ShadowRepository } from './ports.ts';

// Shadow mode (BF-059, champion–challenger): a trained model of the profile's offer scores every business beside
// the profile (stored apart) until it is promoted or withdrawn. Setting it recomputes the profile so the shadow
// scores fill in; the model's status follows (`shadow`, back to `trained` when withdrawn).

@Injectable()
export class ShadowService {
  constructor(
    @Inject(SHADOW_REPOSITORY) private readonly shadows: ShadowRepository,
    @Inject(MODEL_REGISTRY) private readonly registry: ModelRegistry,
    @Inject(SCORING_REPOSITORY) private readonly profiles: ScoringRepository,
    private readonly recompute: RecomputeProfileCommand,
  ) {}

  async set(actor: MlActor, input: SetShadowModelRequest): Promise<ShadowAssignment[]> {
    const request = SetShadowModelRequestSchema.parse(input);
    const profile = await this.profiles.profile(actor.organizationId, request.profileId);
    if (!profile) throw new NotFoundError('ScoringProfile', request.profileId);
    const previous = await this.shadows.unassign(actor.organizationId, profile.id);
    if (previous) {
      const old = await this.registry.model(actor.organizationId, previous);
      if (old?.status === 'shadow') await this.registry.setStatus(actor.organizationId, old.id, 'trained');
    }
    if (request.modelId) {
      const model = await this.registry.model(actor.organizationId, request.modelId);
      if (!model) throw new NotFoundError('ScoringModel', request.modelId);
      if (model.offer !== profile.offer)
        throw new ConflictError('This model was trained for another offer than the profile’s.');
      if (model.status === 'retired' || model.status === 'rejected')
        throw new ConflictError('A retired or rejected model cannot run in shadow.');
      await this.shadows.assign(actor.organizationId, profile.id, model.id, actor.userId);
      if (model.status === 'trained') await this.registry.setStatus(actor.organizationId, model.id, 'shadow');
      await this.recompute.execute(actor.organizationId, profile.id, actor.userId);
    }
    return this.list(actor.organizationId);
  }

  async list(organizationId: string): Promise<ShadowAssignment[]> {
    return [...(await this.shadows.assignments(organizationId)).entries()].map(([profileId, row]) => ({
      profileId,
      modelId: row.modelId,
      startedAt: row.startedAt.toISOString(),
    }));
  }

  async forBusiness(organizationId: string, businessId: string): Promise<ShadowScore[]> {
    const rows = await this.shadows.latest(organizationId, businessId);
    const versions = new Map(
      (await this.registry.models(organizationId)).map((model) => [model.id, model.version]),
    );
    return rows.map((row) => ({
      profileId: row.profileId,
      modelId: row.modelId,
      modelVersion: versions.get(row.modelId) ?? null,
      probability: row.probability,
      score: row.score,
      tier: row.tier,
      reasons: row.reasons,
      computedAt: row.computedAt.toISOString(),
    }));
  }
}
