import {
  type EngineId,
  type GenerationSettings,
  type GenerationSettingsView,
  type GenerationWorkspaceSettings,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { AuditLogger } from '../../workspace/index.ts';
import { effectiveSettings, MAX_CONCURRENCY, settingsProblems } from '../domain/settings.ts';
import {
  ENGINE_REGISTRY,
  type EngineRegistry,
  GENERATION_SETTINGS_STORE,
  type GenerationSettingsReader,
  type GenerationSettingsStore,
} from './ports.ts';

// Settings → Generation (BF-046): a workspace's stored settings over the deployment's defaults. It is also the
// settings reader of every batch and run (BF-039): a batch snapshots what is in force when it is created.

export const GENERATION_SETTINGS_DEFAULTS = Symbol('GenerationSettingsDefaults');

export interface SettingsActor {
  readonly organizationId: string;
  readonly userId: string;
}

@Injectable()
export class GenerationSettingsService implements GenerationSettingsReader {
  constructor(
    @Inject(GENERATION_SETTINGS_DEFAULTS) private readonly defaults: GenerationSettingsReader,
    @Inject(GENERATION_SETTINGS_STORE) private readonly store: GenerationSettingsStore,
    @Inject(ENGINE_REGISTRY) private readonly engines: EngineRegistry,
    @Optional() private readonly audit?: AuditLogger,
  ) {}

  private registered(): EngineId[] {
    return this.engines.list().map((engine) => engine.id);
  }

  async resolve(organizationId: string): Promise<GenerationSettings> {
    const {
      defaultRunMode: _mode,
      presets: _presets,
      ...settings
    } = (await this.view(organizationId)).settings;
    return settings;
  }

  async view(organizationId: string): Promise<GenerationSettingsView> {
    const [defaults, stored] = await Promise.all([
      this.defaults.resolve(organizationId),
      this.store.get(organizationId),
    ]);
    return {
      settings: effectiveSettings(defaults, stored?.settings, this.registered()),
      engines: this.registered(),
      maxConcurrency: MAX_CONCURRENCY,
      updatedAt: stored?.updatedAt.toISOString() ?? null,
    };
  }

  async update(actor: SettingsActor, settings: GenerationWorkspaceSettings): Promise<GenerationSettingsView> {
    const problems = settingsProblems(settings, this.registered());
    if (problems.length > 0)
      throw new ValidationError('These generation settings cannot be saved.', problems);
    await this.store.put(actor.organizationId, actor.userId, settings);
    await this.audit?.record({
      action: 'generation.settings_updated',
      entityType: 'organization',
      entityId: actor.organizationId,
      metadata: {
        allowedEngines: settings.allowedEngines,
        defaultEngine: settings.defaultEngine,
        failoverChain: settings.failoverChain,
        presets: settings.presets.length,
      },
    });
    return this.view(actor.organizationId);
  }
}
