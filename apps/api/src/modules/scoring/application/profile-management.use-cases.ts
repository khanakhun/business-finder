import {
  type ActivateScoringProfileVersionRequest,
  type Clock,
  ConflictError,
  type CreateScoringProfileRequest,
  type CreateScoringProfileVersionRequest,
  NotFoundError,
  type ScoringExplainBatchRequest,
  type ScoringExplainBatchResponse,
  type ScoringPreviewSample,
  type ScoringPreviewSampleQuery,
  type ScoringProfileSummary,
  ScoringProfileVersionActivated,
  type ScoringProfileVersionList,
  type UpdateScoringProfileRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { scoreBusiness } from '../domain/engine.ts';
import {
  FACTS_ASSEMBLER,
  type FactsAssembler,
  type ProfileRecord,
  SCORING_REPOSITORY,
  type ScoringRepository,
} from './ports.ts';
import { ScoringService } from './scoring.service.ts';

// Workspace scoring profiles (BF-032): created from a profile the workspace sees, renamed, archived, versioned and
// activated (activation recomputes the workspace through the outbox). Built-in profiles are read-only.

@Injectable()
export class ScoringProfileCommands {
  constructor(
    @Inject(SCORING_REPOSITORY) private readonly repository: ScoringRepository,
    private readonly scoring: ScoringService,
    private readonly events: EventRecorder,
  ) {}

  @Transactional()
  async create(
    organizationId: string,
    request: CreateScoringProfileRequest,
    userId: string | null,
  ): Promise<ScoringProfileSummary> {
    const source = await this.visible(organizationId, request.fromProfileId);
    if (!source.activeVersion) throw new ConflictError('The profile has no active version to start from.');
    const version = await this.repository.version(source.id, source.activeVersion);
    if (!version) throw new NotFoundError('ScoringProfileVersion', `${source.id}@${source.activeVersion}`);
    const profile = await this.repository.createProfile({
      organizationId,
      offer: source.offer,
      name: request.name,
      config: version.config,
      createdBy: userId,
    });
    await this.activated(organizationId, profile.id, 1);
    return { ...this.summary(profile), primary: false };
  }

  @Transactional()
  async update(
    organizationId: string,
    profileId: string,
    request: UpdateScoringProfileRequest,
  ): Promise<ScoringProfileSummary> {
    const profile = await this.own(organizationId, profileId);
    const primary = await this.scoring.primaryProfileId(organizationId);
    if (request.archived && profile.id === primary) {
      throw new ConflictError(
        'The primary profile cannot be archived: choose another primary profile first.',
      );
    }
    await this.repository.updateProfile(profile.id, {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.archived !== undefined ? { archivedAt: request.archived ? new Date() : null } : {}),
    });
    // Unarchived: it is scored again.
    if (request.archived === false && profile.archived && profile.activeVersion) {
      await this.activated(organizationId, profile.id, profile.activeVersion);
    }
    return {
      ...this.summary(profile),
      name: request.name ?? profile.name,
      archived: request.archived ?? profile.archived,
      primary: profile.id === primary,
    };
  }

  /** A new inactive version (immutable); it must keep the profile's offer. */
  @Transactional()
  async addVersion(
    organizationId: string,
    profileId: string,
    request: CreateScoringProfileVersionRequest,
    userId: string | null,
  ): Promise<{ readonly version: number }> {
    const profile = await this.own(organizationId, profileId);
    if (request.config.offer !== profile.offer) {
      throw new ValidationError('A version keeps its profile’s offer.', [
        { path: ['config', 'offer'], message: `Expected ${profile.offer}` },
      ]);
    }
    return { version: await this.repository.addVersion(profile.id, request.config, userId) };
  }

  /** Activates a saved version: the workspace recomputes with it (progress in realtime). */
  @Transactional()
  async activate(
    organizationId: string,
    profileId: string,
    request: ActivateScoringProfileVersionRequest,
  ): Promise<ScoringProfileSummary> {
    const profile = await this.own(organizationId, profileId);
    if (profile.archived)
      throw new ConflictError('An archived profile cannot be activated: unarchive it first.');
    if (!(await this.repository.version(profile.id, request.version))) {
      throw new NotFoundError('ScoringProfileVersion', `${profile.id}@${request.version}`);
    }
    await this.repository.activate(profile.id, request.version);
    await this.activated(organizationId, profile.id, request.version);
    const primary = await this.scoring.primaryProfileId(organizationId);
    return { ...this.summary(profile), activeVersion: request.version, primary: profile.id === primary };
  }

  private async activated(organizationId: string, profileId: string, version: number): Promise<void> {
    await this.events.record(ScoringProfileVersionActivated, {
      orgId: organizationId,
      payload: { profileId, version },
    });
  }

  private async visible(organizationId: string, profileId: string): Promise<ProfileRecord> {
    const profile = await this.repository.profile(organizationId, profileId);
    if (!profile) throw new NotFoundError('ScoringProfile', profileId);
    return profile;
  }

  /** A profile of this workspace (built-ins are read-only). */
  private async own(organizationId: string, profileId: string): Promise<ProfileRecord> {
    const profile = await this.visible(organizationId, profileId);
    if (profile.builtin)
      throw new ConflictError('Built-in profiles are read-only: duplicate one to change it.');
    return profile;
  }

  private summary(profile: ProfileRecord): Omit<ScoringProfileSummary, 'primary'> {
    return {
      id: profile.id,
      offer: profile.offer,
      name: profile.name,
      builtin: profile.builtin,
      activeVersion: profile.activeVersion,
      archived: profile.archived,
    };
  }
}

/** Reads for the profile editor: versions, the preview sample, and a draft scored over a batch. */
@Injectable()
export class ScoringEditorQueries {
  constructor(
    @Inject(SCORING_REPOSITORY) private readonly repository: ScoringRepository,
    @Inject(FACTS_ASSEMBLER) private readonly assembler: FactsAssembler,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async versions(organizationId: string, profileId: string): Promise<ScoringProfileVersionList> {
    const profile = await this.repository.profile(organizationId, profileId);
    if (!profile) throw new NotFoundError('ScoringProfile', profileId);
    return {
      items: (await this.repository.versions(profileId)).map((v) => ({
        version: v.version,
        active: v.version === profile.activeVersion,
        createdAt: v.createdAt.toISOString(),
      })),
    };
  }

  async sample(organizationId: string, query: ScoringPreviewSampleQuery): Promise<ScoringPreviewSample> {
    if (!(await this.repository.profile(organizationId, query.profileId))) {
      throw new NotFoundError('ScoringProfile', query.profileId);
    }
    return { items: await this.repository.previewSample(organizationId, query.profileId, query.size) };
  }

  /** The engine itself, server-side (the preview never re-implements scoring); untracked businesses left out. */
  async explainBatch(
    organizationId: string,
    request: ScoringExplainBatchRequest,
  ): Promise<ScoringExplainBatchResponse> {
    const facts = await this.assembler.assemble(
      organizationId,
      [...new Set(request.businessIds)],
      new Date(),
    );
    return {
      items: facts.map((business) => {
        const result = scoreBusiness(request.config, business);
        return {
          businessId: business.businessId,
          score: result.score,
          tier: result.tier,
          gate: result.gated?.applied ? result.gated.gate : null,
        };
      }),
    };
  }
}
