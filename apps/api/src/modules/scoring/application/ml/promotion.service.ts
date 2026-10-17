import {
  type Clock,
  ConflictError,
  type ModelPromotion,
  NotFoundError,
  newId,
  type PromoteModelRequest,
  PromoteModelRequestSchema,
  type RollbackModelRequest,
  RollbackModelRequestSchema,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { Transactional } from '../../../platform/db/transactional.ts';
import { AuditLogger } from '../../../workspace/index.ts';
import { SCORING_REPOSITORY, type ScoringRepository } from '../ports.ts';
import { ScoringProfileCommands } from '../profile-management.use-cases.ts';
import type { MlActor } from './dataset-builder.ts';
import {
  MODEL_LIFECYCLE,
  MODEL_REGISTRY,
  type ModelLifecycleRepository,
  type ModelRegistry,
  type PromotionRecord,
  SHADOW_REPOSITORY,
  type ShadowRepository,
} from './ports.ts';
import { ProspectiveComparisonService } from './prospective.ts';

// Promotion and rollback (BF-059). A shadow model becomes its profile's scorer only through a promotion: the
// prospective criteria met, or an owner's explicit override with a reason — both recorded and audited. Promotion
// adds a profile version (`kind: 'model'`, the rules kept) and activates it (the workspace recomputes); the shadow
// ends, the model becomes `active`, the profile's previous model `retired`. Rollback reactivates the version the
// promotion replaced.

/** Default tiers: the shadow probabilities' 80th and 50th percentiles (A for the top fifth, B for the next 30%). */
function percentileTiers(probabilities: number[]): { A: number; B: number } {
  if (probabilities.length < 20) return { A: 0.2, B: 0.08 };
  const sorted = [...probabilities].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const A = Math.min(1, Math.max(at(0.8), 1e-4));
  const B = Math.min(A - 1e-4, Math.max(0, at(0.5)));
  return { A, B };
}

const view = (record: PromotionRecord): ModelPromotion => ({
  id: record.id,
  profileId: record.profileId,
  modelId: record.modelId,
  fromVersion: record.fromVersion,
  toVersion: record.toVersion,
  eligible: record.eligible,
  overrideReason: record.overrideReason,
  comparison: record.comparison,
  promotedBy: record.promotedBy,
  promotedAt: record.promotedAt.toISOString(),
  rolledBackAt: record.rolledBackAt?.toISOString() ?? null,
});

@Injectable()
export class PromotionService {
  constructor(
    @Inject(MODEL_REGISTRY) private readonly registry: ModelRegistry,
    @Inject(SHADOW_REPOSITORY) private readonly shadows: ShadowRepository,
    @Inject(MODEL_LIFECYCLE) private readonly lifecycle: ModelLifecycleRepository,
    @Inject(SCORING_REPOSITORY) private readonly profiles: ScoringRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly commands: ScoringProfileCommands,
    private readonly comparison: ProspectiveComparisonService,
    private readonly audit: AuditLogger,
  ) {}

  @Transactional()
  async promote(actor: MlActor, input: PromoteModelRequest): Promise<ModelPromotion> {
    const request = PromoteModelRequestSchema.parse(input);
    const model = await this.registry.model(actor.organizationId, request.modelId);
    if (!model) throw new NotFoundError('ScoringModel', request.modelId);
    const assignment = (await this.shadows.assignments(actor.organizationId)).get(request.profileId);
    if (assignment?.modelId !== model.id)
      throw new ConflictError('Only the model running in shadow for this profile can be promoted.');
    const profile = await this.profiles.profile(actor.organizationId, request.profileId);
    if (!profile?.activeVersion) throw new NotFoundError('ScoringProfile', request.profileId);
    const comparison = await this.comparison.compare(actor.organizationId, profile.id);
    if (!comparison.eligible && !request.overrideReason)
      throw new ConflictError('The promotion criteria are not met: give a reason to promote anyway.', {
        details: { reason: 'CRITERIA_NOT_MET', comparison },
      });
    const current = await this.profiles.version(profile.id, profile.activeVersion);
    if (!current) throw new NotFoundError('ScoringProfileVersion', `${profile.id}@${profile.activeVersion}`);
    const tiers =
      request.tiers ??
      percentileTiers(await this.lifecycle.shadowProbabilities(actor.organizationId, model.id));
    const { version } = await this.commands.addVersion(
      actor.organizationId,
      profile.id,
      { config: { ...current.config, kind: 'model', model: { modelId: model.id, tiers } } },
      actor.userId,
    );
    await this.commands.activate(actor.organizationId, profile.id, { version });
    const now = this.clock.now();
    const replaced = current.config.kind === 'model' ? current.config.model?.modelId : undefined;
    if (replaced && replaced !== model.id)
      await this.registry.setStatus(actor.organizationId, replaced, 'retired');
    await this.registry.setStatus(actor.organizationId, model.id, 'active', { by: actor.userId, at: now });
    await this.shadows.unassign(actor.organizationId, profile.id);
    const id = newId();
    await this.lifecycle.insertPromotion({
      id,
      organizationId: actor.organizationId,
      profileId: profile.id,
      modelId: model.id,
      fromVersion: profile.activeVersion,
      toVersion: version,
      eligible: comparison.eligible,
      overrideReason: request.overrideReason ?? null,
      comparison,
      promotedBy: actor.userId,
    });
    await this.audit.record({
      action: 'scoring.model_promoted',
      organizationId: actor.organizationId,
      entityType: 'scoring_profile',
      entityId: profile.id,
      metadata: {
        modelId: model.id,
        modelVersion: model.version,
        fromVersion: profile.activeVersion,
        toVersion: version,
        eligible: comparison.eligible,
        overrideReason: request.overrideReason ?? null,
        tiers,
      },
    });
    const stored = await this.lifecycle.latestPromotion(actor.organizationId, profile.id);
    if (!stored) throw new NotFoundError('ModelPromotion', id);
    return view(stored);
  }

  @Transactional()
  async rollback(actor: MlActor, input: RollbackModelRequest): Promise<ModelPromotion> {
    const request = RollbackModelRequestSchema.parse(input);
    const promotion = await this.lifecycle.latestPromotion(actor.organizationId, request.profileId);
    if (!promotion) throw new NotFoundError('ModelPromotion', request.profileId);
    await this.commands.activate(actor.organizationId, request.profileId, { version: promotion.fromVersion });
    await this.registry.setStatus(actor.organizationId, promotion.modelId, 'retired');
    const now = this.clock.now();
    await this.lifecycle.markRolledBack(promotion.id, actor.userId, now);
    await this.audit.record({
      action: 'scoring.model_rolled_back',
      organizationId: actor.organizationId,
      entityType: 'scoring_profile',
      entityId: request.profileId,
      metadata: { modelId: promotion.modelId, restoredVersion: promotion.fromVersion },
    });
    return view({ ...promotion, rolledBackAt: now });
  }

  async list(organizationId: string): Promise<ModelPromotion[]> {
    return (await this.lifecycle.promotions(organizationId)).map(view);
  }
}
