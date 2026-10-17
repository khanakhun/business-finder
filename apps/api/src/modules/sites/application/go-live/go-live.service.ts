import { createHash, randomBytes } from 'node:crypto';
import type { ApiEnv } from '@bf/config';
import {
  type Clock,
  ConflictError,
  ForbiddenError,
  type GoLiveReadiness,
  NotFoundError,
  type PublishLiveRequest,
  PublishLiveRequestSchema,
  type PublishLiveResult,
  type SaveSiteLegalProfileRequest,
  SaveSiteLegalProfileRequestSchema,
  type SetContactRoutingRequest,
  SetContactRoutingRequestSchema,
  type SiteContactRouting,
  type SiteLegalProfile,
  ValidationError,
} from '@bf/contracts';
import { validateSite } from '@bf/site-schema';
import { Inject, Injectable } from '@nestjs/common';
import { SYSTEM_MAILER, type SystemMailer } from '../../../identity/index.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../../../platform/config/app-env.ts';
import { AuditLogger, WorkspaceDefaults } from '../../../workspace/index.ts';
import { evaluateReadiness } from '../../domain/go-live-readiness.ts';
import { SITE_HOSTING, SITES_REPOSITORY, type SiteHosting, type SitesRepository } from '../ports.ts';
import { type SiteActor, SiteCommands } from '../sites.commands.ts';
import { DomainsService } from './domains.service.ts';
import { GO_LIVE_REPOSITORY, type GoLiveRepository } from './ports.ts';

// Going live (BF-062): the readiness checks, the legal profile the legal pages are generated from, the contact
// routing address (confirmed by a link sent to it), and the live publication — refused while a check fails.
// Going live without a deal needs a reason and `settings:manage` besides `sites:publish`.

const TOKEN_TTL_MS = 7 * 24 * 3_600_000;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export interface GoLiveActor extends SiteActor {
  /** May go live without a deal (holds `settings:manage`). */
  readonly canOverride: boolean;
  readonly locale: 'en' | 'fr';
}

@Injectable()
export class GoLiveService {
  constructor(
    @Inject(GO_LIVE_REPOSITORY) private readonly repository: GoLiveRepository,
    @Inject(SITES_REPOSITORY) private readonly sites: SitesRepository,
    @Inject(SITE_HOSTING) private readonly hosting: SiteHosting,
    @Inject(SYSTEM_MAILER) private readonly mailer: SystemMailer,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly commands: SiteCommands,
    private readonly domains: DomainsService,
    private readonly workspace: WorkspaceDefaults,
    private readonly audit: AuditLogger,
  ) {}

  private async site(actor: SiteActor, siteId: string) {
    const site = await this.sites.site(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    return site;
  }

  async readiness(
    actor: SiteActor,
    siteId: string,
    versionId?: string,
    overrideReason?: string,
  ): Promise<GoLiveReadiness> {
    const site = await this.site(actor, siteId);
    const id = versionId ?? site.currentVersionId;
    if (!id) throw new ConflictError('The site has no version yet.');
    const version = await this.sites.version(site.id, id);
    if (!version) throw new NotFoundError('SiteVersion', id);
    const [context, legal, routing, identity] = await Promise.all([
      this.repository.context(actor.organizationId, site.id, version.id),
      this.repository.legal(actor.organizationId, site.id),
      this.repository.routing(actor.organizationId, site.id),
      this.workspace.identity(actor.organizationId),
    ]);
    const issues = validateSite(version.spec, {
      assetHosts: this.hosting.assetHosts,
      hotlinkHosts: this.hosting.hotlinkHosts ?? [],
      mode: 'published',
      environment: 'live',
    }).filter((issue) => issue.severity === 'error');
    const spec = version.spec as {
      locales?: string[];
      seo?: { title?: Record<string, string>; description?: Record<string, string> };
      pages?: { seo?: { title?: Record<string, string>; description?: Record<string, string> } }[];
    };
    const locales = spec.locales ?? [];
    const gaps = (
      seo: { title?: Record<string, string>; description?: Record<string, string> } | undefined,
    ) =>
      locales.filter((locale) => !seo?.title?.[locale]?.trim() || !seo?.description?.[locale]?.trim()).length;
    const checks = evaluateReadiness({
      siteId: site.id,
      pipelineStatus: context?.pipelineStatus ?? null,
      overrideReason: overrideReason ?? null,
      countryCode: context?.countryCode ?? null,
      liveErrors: issues.map((issue) => ({ code: issue.code, message: issue.message })),
      legal: legal ?? null,
      host: {
        name: identity.legalName ?? identity.agencyName,
        address: identity.postalAddress
          ? [
              identity.postalAddress.line1,
              identity.postalAddress.postalCode,
              identity.postalAddress.city,
            ].join(' ')
          : null,
      },
      routingVerified: Boolean(routing?.verifiedAt && routing.recipientEmail),
      quality: context?.quality ?? null,
      seo: {
        missingSite: gaps(spec.seo),
        missingPages: (spec.pages ?? []).reduce((sum, page) => sum + gaps(page.seo), 0),
      },
    });
    return {
      siteId: site.id,
      versionId: version.id,
      checks,
      ready: checks.every((check) => check.status !== 'fail'),
    };
  }

  // ── Legal profile ─────────────────────────────────────────────────────────────────────────────────────────

  async legal(actor: SiteActor, siteId: string): Promise<SiteLegalProfile | null> {
    await this.site(actor, siteId);
    return (await this.repository.legal(actor.organizationId, siteId)) ?? null;
  }

  async saveLegal(
    actor: SiteActor,
    siteId: string,
    input: SaveSiteLegalProfileRequest,
  ): Promise<SiteLegalProfile> {
    const request = SaveSiteLegalProfileRequestSchema.parse(input);
    await this.site(actor, siteId);
    const previous = await this.repository.legal(actor.organizationId, siteId);
    const now = this.clock.now().toISOString();
    return this.repository.saveLegal(
      actor.organizationId,
      siteId,
      {
        businessLegalName: request.businessLegalName,
        legalForm: request.legalForm,
        registration: request.registration,
        vatNumber: request.vatNumber,
        address: request.address,
        phone: request.phone,
        email: request.email,
        publicationDirector: request.publicationDirector,
        dpoContact: request.dpoContact,
        privacyAcknowledgedAt: request.acknowledgePrivacy ? now : (previous?.privacyAcknowledgedAt ?? null),
        contentConfirmedBy: request.contentConfirmedBy ?? previous?.contentConfirmedBy ?? null,
        contentConfirmedAt: request.contentConfirmedBy ? now : (previous?.contentConfirmedAt ?? null),
      },
      actor.userId,
    );
  }

  // ── Contact routing ───────────────────────────────────────────────────────────────────────────────────────

  async routing(actor: SiteActor, siteId: string): Promise<SiteContactRouting> {
    await this.site(actor, siteId);
    const row = await this.repository.routing(actor.organizationId, siteId);
    return {
      recipientEmail: row?.recipientEmail ?? null,
      cc: row?.cc ?? null,
      verifiedAt: row?.verifiedAt?.toISOString() ?? null,
      pendingEmail: row?.pendingEmail ?? null,
    };
  }

  /** Sends a confirmation link to the address; messages go there once it is confirmed. */
  async setRouting(
    actor: GoLiveActor,
    siteId: string,
    input: SetContactRoutingRequest,
  ): Promise<SiteContactRouting> {
    const request = SetContactRoutingRequestSchema.parse(input);
    const site = await this.site(actor, siteId);
    const token = randomBytes(32).toString('base64url');
    await this.repository.setPending(actor.organizationId, site.id, {
      email: request.email,
      cc: request.cc,
      tokenHash: sha256(token),
      expiresAt: new Date(this.clock.now().getTime() + TOKEN_TTL_MS),
    });
    const fr = actor.locale === 'fr';
    await this.mailer.sendNotification({
      to: request.email,
      locale: actor.locale,
      title: fr
        ? `Confirmez l’adresse des messages du site ${site.businessName}`
        : `Confirm where ${site.businessName}'s website messages go`,
      body: fr
        ? 'Les messages envoyés depuis le formulaire de contact du site arriveront à cette adresse une fois confirmée. Ignorez cet e-mail si vous n’êtes pas concerné.'
        : 'Messages sent from the website’s contact form will reach this address once you confirm it. Ignore this email if it was not meant for you.',
      url: `${(this.env as ApiEnv).APP_URL}/confirm-contact?token=${token}`,
    });
    return this.routing(actor, site.id);
  }

  /** The confirmation link (anonymous: the token is the proof). Same answer for unknown or expired tokens. */
  async confirmRouting(token: string): Promise<{ confirmed: boolean }> {
    const row = await this.repository.confirm(sha256(token), this.clock.now());
    return { confirmed: row !== undefined };
  }

  // ── Live publication ──────────────────────────────────────────────────────────────────────────────────────

  async publishLive(
    actor: GoLiveActor,
    siteId: string,
    input: PublishLiveRequest,
  ): Promise<PublishLiveResult> {
    const request = PublishLiveRequestSchema.parse(input);
    if (request.overrideReason && !actor.canOverride)
      throw new ForbiddenError('Going live without a deal needs the settings permission.');
    const readiness = await this.readiness(actor, siteId, request.versionId, request.overrideReason);
    if (!readiness.ready)
      throw new ValidationError(
        'The site is not ready to go live.',
        readiness.checks
          .filter((check) => check.status === 'fail')
          .map((check) => ({ path: ['checks', check.id], message: check.message, code: check.id })),
        { details: { reason: 'NOT_READY' } },
      );
    const publication = await this.commands.publishLive(actor, siteId, request.versionId);
    // Verified custom domains are served at once.
    await this.domains.activateForSite(actor.organizationId, siteId);
    await this.audit.record({
      action: 'sites.published_live',
      organizationId: actor.organizationId,
      entityType: 'site',
      entityId: siteId,
      metadata: {
        versionId: request.versionId,
        hostname: publication.hostname,
        overrideReason: request.overrideReason ?? null,
        warnings: readiness.checks.filter((check) => check.status === 'warn').map((check) => check.id),
      },
    });
    return { publicationId: publication.id, hostname: publication.hostname, readiness };
  }
}
