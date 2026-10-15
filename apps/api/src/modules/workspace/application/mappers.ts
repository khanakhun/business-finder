import type { AuditLogEntry, OrgSettings } from '@bf/contracts';
import { featureStates } from '../domain/feature-flags.ts';
import { outreachReadiness } from '../domain/readiness.ts';
import type { AuditEntryRecord, DeploymentEnv, OrgSettingsRecord } from './ports.ts';

/** What a workspace has before its settings are first saved. */
export const DEFAULT_SETTINGS = {
  agencyName: null,
  legalName: null,
  postalAddress: null,
  websiteUrl: null,
  logoAssetKey: null,
  logoContentType: null,
  primaryLocale: 'en',
  locales: ['en'],
  timezone: 'UTC',
  senderDefaults: {},
  features: {},
  updatedAt: null,
} as const satisfies Omit<OrgSettingsRecord, 'organizationId'>;

export function toOrgSettings(record: OrgSettingsRecord | undefined, env: DeploymentEnv): OrgSettings {
  const settings = record ?? DEFAULT_SETTINGS;
  return {
    agencyName: settings.agencyName,
    legalName: settings.legalName,
    postalAddress: settings.postalAddress,
    websiteUrl: settings.websiteUrl,
    hasLogo: settings.logoAssetKey !== null,
    primaryLocale: settings.primaryLocale,
    locales: [...settings.locales],
    timezone: settings.timezone,
    senderDefaults: settings.senderDefaults,
    features: featureStates(settings.features, env),
    outreachReadiness: outreachReadiness(settings),
    updatedAt: settings.updatedAt?.toISOString() ?? null,
  };
}

export function toAuditLogEntry(record: AuditEntryRecord): AuditLogEntry {
  return {
    id: record.id,
    actorType: record.actorType,
    actorId: record.actorId,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    ip: record.ip,
    userAgent: record.userAgent,
    metadata: record.metadata,
    occurredAt: record.occurredAt.toISOString(),
  };
}
