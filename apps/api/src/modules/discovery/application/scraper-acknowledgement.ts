import type { ApiEnv } from '@bf/config';
import {
  ConflictError,
  ForbiddenError,
  SCRAPER_WARNING,
  SCRAPER_WARNING_VERSION,
  type ScraperStatus,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../platform/config/app-env.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { AuditLogger, AuditTrail, FeatureFlagService } from '../../workspace/index.ts';

const ACTION_PREFIX = 'discovery.scraper_tos_';
export const SCRAPER_ACKNOWLEDGED = 'discovery.scraper_tos_acknowledged';
export const SCRAPER_REVOKED = 'discovery.scraper_tos_revoked';

/**
 * The scraper's third gate (BF-019): a workspace owner acknowledges the ToS warning; the acknowledgement lives
 * in the append-only audit log (who, when, which warning version). The latest acknowledge/revoke entry wins, and
 * a new warning version invalidates earlier acknowledgements.
 */
@Injectable()
export class ScraperAcknowledgement {
  constructor(
    private readonly trail: AuditTrail,
    private readonly audit: AuditLogger,
    private readonly flags: FeatureFlagService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  async current(organizationId: string): Promise<ScraperStatus['acknowledgement']> {
    const entry = await this.trail.latest(organizationId, ACTION_PREFIX);
    if (entry?.action !== SCRAPER_ACKNOWLEDGED || entry.metadata?.warningVersion !== SCRAPER_WARNING_VERSION)
      return null;
    return {
      userId: entry.actorId,
      acknowledgedAt: entry.occurredAt.toISOString(),
      warningVersion: SCRAPER_WARNING_VERSION,
    };
  }

  async isAcknowledged(organizationId: string): Promise<boolean> {
    return (await this.current(organizationId)) !== null;
  }

  /** The workspace gates checked on every scraper call: its feature flag and the owner acknowledgement. */
  async allowed(organizationId: string): Promise<boolean> {
    return (
      (await this.flags.isEnabled(organizationId, 'mapsScraper')) &&
      (await this.isAcknowledged(organizationId))
    );
  }

  async status(auth: AuthContext): Promise<ScraperStatus> {
    const orgId = workspaceOf(auth);
    const env = this.env as ApiEnv;
    const deployed = env.FEATURE_MAPS_SCRAPER && Boolean(env.MAPS_SCRAPER_URL);
    const flagEnabled = await this.flags.isEnabled(orgId, 'mapsScraper');
    const acknowledgement = await this.current(orgId);
    return {
      deployed,
      flagEnabled,
      acknowledgement,
      allowed: deployed && flagEnabled && acknowledgement !== null,
      warningVersion: SCRAPER_WARNING_VERSION,
      warning: SCRAPER_WARNING,
    };
  }

  async acknowledge(auth: AuthContext, warningVersion: number): Promise<ScraperStatus> {
    this.ownerWorkspace(auth);
    const env = this.env as ApiEnv;
    // An acknowledgement must not lie dormant and activate silently when the scraper is deployed later.
    if (!(env.FEATURE_MAPS_SCRAPER && env.MAPS_SCRAPER_URL)) {
      throw new ConflictError('The Google Maps scraper is not deployed.', {
        details: { reason: 'SCRAPER_NOT_DEPLOYED' },
      });
    }
    if (warningVersion !== SCRAPER_WARNING_VERSION) {
      throw new ForbiddenError('The warning changed: read the current version before acknowledging it.', {
        details: { reason: 'STALE_WARNING' },
      });
    }
    await this.audit.record({
      auth,
      action: SCRAPER_ACKNOWLEDGED,
      entityType: 'discovery_provider',
      entityId: 'gmaps_scraper',
      metadata: { warningVersion },
    });
    return this.status(auth);
  }

  async revoke(auth: AuthContext): Promise<ScraperStatus> {
    this.ownerWorkspace(auth);
    await this.audit.record({
      auth,
      action: SCRAPER_REVOKED,
      entityType: 'discovery_provider',
      entityId: 'gmaps_scraper',
    });
    return this.status(auth);
  }

  /** Only a workspace owner (signed in, not an API key) may accept the legal risk. */
  private ownerWorkspace(auth: AuthContext): string {
    const orgId = workspaceOf(auth);
    if (auth.method !== 'session' || auth.role !== 'owner') {
      throw new ForbiddenError('Only a workspace owner can acknowledge the scraper warning.', {
        details: { reason: 'OWNER_REQUIRED' },
      });
    }
    return orgId;
  }
}

function workspaceOf(auth: AuthContext): string {
  if (!auth.orgId) throw new Error('Discovery route reached without an active workspace');
  return auth.orgId;
}
