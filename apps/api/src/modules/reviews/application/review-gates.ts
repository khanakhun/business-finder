import {
  ForbiddenError,
  GOOGLE_REVIEWS_TERMS,
  REVIEW_SOURCES,
  type ReviewSource,
  type ReviewSourceGate,
  type ReviewSourcesStatus,
  type UpdateReviewSourcesRequest,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { AuditLogger, AuditTrail, SecretResolver } from '../../workspace/index.ts';
import { resolveGate } from '../domain/gates.ts';
import {
  REVIEW_SOURCE_SETTINGS,
  type ReviewSourceSettingsRepository,
  SCRAPER_GATE,
  type ScraperGate,
} from './ports.ts';
import { ReviewMiningService } from './review-mining.service.ts';

const GOOGLE_ACTION_PREFIX = 'reviews.google_terms_';
export const GOOGLE_TERMS_ACKNOWLEDGED = 'reviews.google_terms_acknowledged';
export const GOOGLE_TERMS_REVOKED = 'reviews.google_terms_revoked';

/**
 * Licensing gates per workspace and review source (BF-029, Gatekeeper). Google needs an owner's acknowledgement of
 * the terms warning (append-only audit log: who, when, which terms version, URL and date) and a Places key; the
 * scraper needs the workspace's opt-in and its own gates; pasted reviews are allowed. Turning a source off also
 * forgets what was derived from it.
 */
@Injectable()
export class ReviewGates {
  constructor(
    @Inject(REVIEW_SOURCE_SETTINGS) private readonly settings: ReviewSourceSettingsRepository,
    @Inject(SCRAPER_GATE) private readonly scraper: ScraperGate,
    private readonly trail: AuditTrail,
    private readonly audit: AuditLogger,
    private readonly secrets: SecretResolver,
    private readonly mining: ReviewMiningService,
  ) {}

  async gatesFor(organizationId: string): Promise<ReviewSourceGate[]> {
    const [chosen, acknowledgement, key, scraperAllowed] = await Promise.all([
      this.settings.list(organizationId),
      this.googleAcknowledgement(organizationId),
      this.secrets.resolve(organizationId, 'google_places'),
      this.scraper.allowed(organizationId),
    ]);
    return REVIEW_SOURCES.map((source) =>
      resolveGate(source, {
        chosen: chosen[source],
        acknowledged: acknowledgement !== null,
        keyConfigured: key !== undefined,
        scraperAllowed,
      }),
    );
  }

  /** The sources the workspace may analyse now (and how). */
  async allowedSources(organizationId: string): Promise<ReviewSourceGate[]> {
    return (await this.gatesFor(organizationId)).filter((gate) => gate.effective !== 'none');
  }

  async isAllowed(organizationId: string, source: ReviewSource): Promise<boolean> {
    return (await this.gatesFor(organizationId)).some((g) => g.source === source && g.effective !== 'none');
  }

  async status(auth: AuthContext): Promise<ReviewSourcesStatus> {
    const organizationId = workspaceOf(auth);
    return {
      sources: await this.gatesFor(organizationId),
      googleTerms: GOOGLE_REVIEWS_TERMS,
      googleAcknowledgement: await this.googleAcknowledgement(organizationId),
    };
  }

  async update(auth: AuthContext, body: UpdateReviewSourcesRequest): Promise<ReviewSourcesStatus> {
    const organizationId = workspaceOf(auth);
    const before = await this.settings.list(organizationId);
    await this.settings.set(organizationId, 'gmaps_scraper', body.gmapsScraper, auth.userId);
    await this.audit.record({
      auth,
      action: 'reviews.sources_updated',
      entityType: 'review_source',
      entityId: 'gmaps_scraper',
      metadata: { from: before.gmaps_scraper ?? 'none', to: body.gmapsScraper },
    });
    if (body.gmapsScraper === 'none') await this.mining.forgetSource(organizationId, 'gmaps_scraper');
    return this.status(auth);
  }

  async acknowledgeGoogle(auth: AuthContext, termsVersion: number): Promise<ReviewSourcesStatus> {
    ownerOnly(auth);
    if (termsVersion !== GOOGLE_REVIEWS_TERMS.version) {
      throw new ForbiddenError('The warning changed: read the current version before acknowledging it.', {
        details: { reason: 'STALE_WARNING' },
      });
    }
    await this.audit.record({
      auth,
      action: GOOGLE_TERMS_ACKNOWLEDGED,
      entityType: 'review_source',
      entityId: 'google_places',
      metadata: {
        termsVersion,
        termsUrl: GOOGLE_REVIEWS_TERMS.url,
        termsLastModified: GOOGLE_REVIEWS_TERMS.lastModified,
      },
    });
    return this.status(auth);
  }

  /** Turning a risky source off only reduces exposure: any member who manages settings may do it. */
  async revokeGoogle(auth: AuthContext): Promise<ReviewSourcesStatus> {
    await this.audit.record({
      auth,
      action: GOOGLE_TERMS_REVOKED,
      entityType: 'review_source',
      entityId: 'google_places',
    });
    await this.mining.forgetSource(workspaceOf(auth), 'google_places');
    return this.status(auth);
  }

  private async googleAcknowledgement(
    organizationId: string,
  ): Promise<ReviewSourcesStatus['googleAcknowledgement']> {
    const entry = await this.trail.latest(organizationId, GOOGLE_ACTION_PREFIX);
    if (
      entry?.action !== GOOGLE_TERMS_ACKNOWLEDGED ||
      entry.metadata?.termsVersion !== GOOGLE_REVIEWS_TERMS.version
    )
      return null;
    return {
      userId: entry.actorId,
      acknowledgedAt: entry.occurredAt.toISOString(),
      termsVersion: GOOGLE_REVIEWS_TERMS.version,
    };
  }
}

/** Only a workspace owner, signed in (not an API key), may accept the licensing risk. */
function ownerOnly(auth: AuthContext): void {
  workspaceOf(auth);
  if (auth.method !== 'session' || auth.role !== 'owner') {
    throw new ForbiddenError('Only a workspace owner can acknowledge the Google terms warning.', {
      details: { reason: 'OWNER_REQUIRED' },
    });
  }
}

export function workspaceOf(auth: AuthContext): string {
  if (!auth.orgId) {
    throw new ForbiddenError('Select a workspace first.', { details: { reason: 'NO_ACTIVE_WORKSPACE' } });
  }
  return auth.orgId;
}
