import {
  NotFoundError,
  newId,
  type OrgSettings,
  type UpdateOrgSettingsRequest,
  ValidationError,
} from '@bf/contracts';
import type { Logger } from '@bf/observability';
import { Inject, Injectable } from '@nestjs/common';
import { Transactional } from '../../platform/db/transactional.ts';
import { LOGGER } from '../../platform/logging/logger.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { OBJECT_STORAGE, type ObjectStorage } from '../../platform/storage/object-storage.ts';
import { assertCanSet } from '../domain/feature-flags.ts';
import { validateLogo } from '../domain/logo.ts';
import { AuditLogger } from './audit-logger.ts';
import { DEFAULT_SETTINGS, toOrgSettings } from './mappers.ts';
import {
  DEPLOYMENT_ENV,
  type DeploymentEnv,
  ORG_SETTINGS_REPOSITORY,
  type OrgSettingsPatch,
  type OrgSettingsRepository,
} from './ports.ts';

/** Routes guarantee an active workspace (`@RequirePermission` / `@AnyMember`). */
type WorkspaceAuth = AuthContext & { readonly orgId: string };

export function workspaceOf(auth: AuthContext): string {
  if (!auth.orgId) throw new Error('Workspace route reached without an active workspace');
  return auth.orgId;
}

@Injectable()
export class GetSettingsQuery {
  constructor(
    @Inject(ORG_SETTINGS_REPOSITORY) private readonly settings: OrgSettingsRepository,
    @Inject(DEPLOYMENT_ENV) private readonly env: DeploymentEnv,
  ) {}

  async execute(auth: AuthContext): Promise<OrgSettings> {
    return toOrgSettings(await this.settings.find(workspaceOf(auth)), this.env);
  }
}

@Injectable()
export class UpdateSettingsCommand {
  constructor(
    @Inject(ORG_SETTINGS_REPOSITORY) private readonly settings: OrgSettingsRepository,
    @Inject(DEPLOYMENT_ENV) private readonly env: DeploymentEnv,
    private readonly audit: AuditLogger,
  ) {}

  @Transactional()
  async execute(auth: AuthContext, body: UpdateOrgSettingsRequest): Promise<OrgSettings> {
    const orgId = workspaceOf(auth);
    const current = (await this.settings.find(orgId)) ?? DEFAULT_SETTINGS;
    if (body.features) assertCanSet(body.features, this.env);
    const locales = body.locales ?? current.locales;
    const primaryLocale = body.primaryLocale ?? current.primaryLocale;
    if (!locales.includes(primaryLocale)) {
      throw new ValidationError('The primary language must be one of the workspace languages.', [
        { path: ['primaryLocale'], message: 'Not in locales' },
      ]);
    }
    // Only the fields sent change (Zod's partial output types allow explicit `undefined`).
    const sent = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
    const patch = {
      ...sent,
      ...(body.features ? { features: { ...current.features, ...body.features } } : {}),
    } as OrgSettingsPatch;
    const saved = await this.settings.upsert(orgId, patch, auth.userId);
    await this.audit.record({
      auth,
      action: 'settings.updated',
      entityType: 'org_settings',
      entityId: orgId,
      metadata: { changed: Object.keys(sent).sort(), ...(body.features ? { features: body.features } : {}) },
    });
    return toOrgSettings(saved, this.env);
  }
}

@Injectable()
export class LogoUseCases {
  constructor(
    @Inject(ORG_SETTINGS_REPOSITORY) private readonly settings: OrgSettingsRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly audit: AuditLogger,
  ) {}

  /** Stores the image, then points the settings at it; the previous image is deleted afterwards. */
  async upload(auth: WorkspaceAuth, body: Buffer, declaredType: string | undefined): Promise<void> {
    const orgId = workspaceOf(auth);
    const contentType = validateLogo(body, declaredType);
    const key = `orgs/${orgId}/logo/${newId()}`;
    await this.storage.put(key, body, contentType);
    const previous = await this.replace(auth, key, contentType, {
      action: 'settings.logo_updated',
      metadata: { contentType, bytes: body.length },
    });
    await this.deleteQuietly(previous);
  }

  async remove(auth: WorkspaceAuth): Promise<void> {
    const previous = await this.replace(auth, null, null, { action: 'settings.logo_removed', metadata: {} });
    if (!previous) throw new NotFoundError('Logo', workspaceOf(auth));
    await this.deleteQuietly(previous);
  }

  async get(auth: AuthContext): Promise<{ readonly body: Buffer; readonly contentType: string }> {
    const orgId = workspaceOf(auth);
    const key = (await this.settings.find(orgId))?.logoAssetKey;
    const object = key ? await this.storage.get(key) : undefined;
    if (!object) throw new NotFoundError('Logo', orgId);
    return object;
  }

  @Transactional()
  private async replace(
    auth: AuthContext,
    key: string | null,
    contentType: string | null,
    entry: { readonly action: string; readonly metadata: Record<string, unknown> },
  ): Promise<string | null> {
    const orgId = workspaceOf(auth);
    const previous = (await this.settings.find(orgId))?.logoAssetKey ?? null;
    if (key === null && previous === null) return null;
    await this.settings.upsert(orgId, { logoAssetKey: key, logoContentType: contentType }, auth.userId);
    await this.audit.record({ ...entry, auth, entityType: 'org_settings', entityId: orgId });
    return previous;
  }

  private async deleteQuietly(key: string | null): Promise<void> {
    if (!key) return;
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn({ err: error, key }, 'Could not delete the previous logo object');
    }
  }
}
