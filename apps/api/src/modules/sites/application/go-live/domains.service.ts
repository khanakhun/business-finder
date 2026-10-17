import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiEnv } from '@bf/config';
import {
  type AddSiteDomainRequest,
  AddSiteDomainRequestSchema,
  type Clock,
  ConflictError,
  NotFoundError,
  newId,
  type SiteDomain,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../../../platform/config/app-env.ts';
import { LOGGER, type Logger } from '../../../platform/logging/logger.ts';
import { AuditLogger } from '../../../workspace/index.ts';
import {
  classifyHostname,
  evaluateDns,
  expectedRecords,
  type Ingress,
  nextState,
  verificationName,
} from '../../domain/domain-verification.ts';
import { SITE_HOSTING, SITES_REPOSITORY, type SiteHosting, type SitesRepository } from '../ports.ts';
import { type SiteActor, SiteCommands } from '../sites.commands.ts';
import {
  DNS_RESOLVER,
  type DnsResolver,
  DOMAIN_REPOSITORY,
  type DomainRecord,
  type DomainRepository,
} from './ports.ts';

// Custom domains (BF-062). Adding one (and its `www`) gives the records to create; a worker checks them with
// backoff for 72 hours (and on demand); a verified domain of a live site is served at once (a live publication
// per hostname), and the site's own hostname redirects there. Certificates are issued by Caddy on demand, and
// only for names this service allows (`allow`, the `ask` endpoint): verified or active ones.

const SWEEP_MS = 60_000;

export const DOMAIN_SWEEP_AUTOSTART = Symbol('DomainSweepAutostart');

@Injectable()
export class DomainsService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    @Inject(DOMAIN_REPOSITORY) private readonly domains: DomainRepository,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(SITES_REPOSITORY) private readonly sites: SitesRepository,
    @Inject(SITE_HOSTING) private readonly hosting: SiteHosting,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly commands: SiteCommands,
    private readonly audit: AuditLogger,
    @Optional() @Inject(DOMAIN_SWEEP_AUTOSTART) private readonly autostart?: boolean,
  ) {}

  onModuleInit() {
    if (!this.autostart) return;
    this.timer = setInterval(
      () =>
        void this.sweep().catch((err: unknown) =>
          this.logger.warn({ err }, 'domain verification sweep failed'),
        ),
      SWEEP_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private ingress(): Ingress {
    const env = this.env as ApiEnv;
    return {
      cnameTarget: `cname.${this.hosting.baseDomain}`,
      ips: env.SITES_INGRESS_IPS.split(',')
        .map((ip) => ip.trim())
        .filter(Boolean),
    };
  }

  private view(row: DomainRecord): SiteDomain {
    return {
      id: row.id,
      hostname: row.hostname,
      kind: row.kind,
      redirectTo: row.redirectTo,
      status: row.status,
      records: expectedRecords(
        { hostname: row.hostname, kind: row.kind, token: row.verificationToken },
        this.ingress(),
      ),
      report: row.dnsReport,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async site(actor: SiteActor, siteId: string) {
    const site = await this.sites.site(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    return site;
  }

  async list(actor: SiteActor, siteId: string): Promise<SiteDomain[]> {
    await this.site(actor, siteId);
    return (await this.domains.forSite(actor.organizationId, siteId))
      .filter((row) => row.status !== 'removed')
      .map((row) => this.view(row));
  }

  async add(actor: SiteActor, siteId: string, input: AddSiteDomainRequest): Promise<SiteDomain[]> {
    const request = AddSiteDomainRequestSchema.parse(input);
    const site = await this.site(actor, siteId);
    const base = this.hosting.baseDomain.toLowerCase();
    const appBase = new URL((this.env as ApiEnv).APP_URL).hostname;
    if (
      request.hostname === base ||
      request.hostname.endsWith(`.${base}`) ||
      request.hostname.endsWith(appBase)
    )
      throw new ValidationError('Use the business’s own domain.', [
        { path: ['hostname'], message: 'Our own domains cannot be attached' },
      ]);
    const { kind, apex } = classifyHostname(request.hostname);
    const token = `bf-${randomBytes(18).toString('base64url')}`;
    const rows: Parameters<DomainRepository['insert']>[0][number][] = [];
    const hostname = kind === 'www' ? apex : request.hostname;
    const primaryKind = kind === 'www' ? 'apex' : kind;
    rows.push({
      id: newId(),
      organizationId: actor.organizationId,
      siteId: site.id,
      hostname,
      kind: primaryKind,
      redirectTo: null,
      verificationToken: token,
      createdBy: actor.userId,
    } as never);
    if (primaryKind === 'apex' && (request.includeWww || kind === 'www'))
      rows.push({
        id: newId(),
        organizationId: actor.organizationId,
        siteId: site.id,
        hostname: `www.${apex}`,
        kind: 'www',
        redirectTo: apex,
        verificationToken: token,
        createdBy: actor.userId,
      } as never);
    for (const row of rows) {
      const existing = await this.domains.byHostname(row.hostname);
      if (existing && existing.status !== 'removed')
        throw new ConflictError(`${row.hostname} is already attached to a site.`);
    }
    await this.domains.insert(rows);
    await this.audit.record({
      action: 'sites.domain_added',
      organizationId: actor.organizationId,
      entityType: 'site',
      entityId: site.id,
      metadata: { hostnames: rows.map((row) => row.hostname) },
    });
    return this.list(actor, site.id);
  }

  /** "Check now". */
  async check(actor: SiteActor, siteId: string, domainId: string): Promise<SiteDomain> {
    const row = (await this.domains.forSite(actor.organizationId, siteId)).find((d) => d.id === domainId);
    if (!row || row.status === 'removed') throw new NotFoundError('SiteDomain', domainId);
    return this.view(await this.verify(row));
  }

  async remove(actor: SiteActor, siteId: string, domainId: string): Promise<void> {
    const row = (await this.domains.forSite(actor.organizationId, siteId)).find((d) => d.id === domainId);
    if (!row || row.status === 'removed') throw new NotFoundError('SiteDomain', domainId);
    await this.domains.update(row.id, { status: 'removed' });
    await this.commands.detachHostname(actor.organizationId, siteId, row.hostname);
    await this.audit.record({
      action: 'sites.domain_removed',
      organizationId: actor.organizationId,
      entityType: 'site',
      entityId: siteId,
      metadata: { hostname: row.hostname },
    });
  }

  /** The worker's sweep: due checks, claimed so two workers never check the same name. */
  async sweep(): Promise<number> {
    const due = await this.domains.claimDue(this.clock.now(), 25);
    for (const row of due)
      await this.verify(row).catch((err: unknown) =>
        this.logger.warn({ err, domainId: row.id }, 'domain verification failed'),
      );
    return due.length;
  }

  private async verify(row: DomainRecord): Promise<DomainRecord> {
    if (row.status === 'verified' || row.status === 'active') return row;
    const now = this.clock.now();
    const domain = { hostname: row.hostname, kind: row.kind, token: row.verificationToken };
    const checks = evaluateDns(
      domain,
      this.ingress(),
      await this.dns.answers(row.hostname, verificationName(row.hostname)),
    );
    const next = nextState(checks, row, now);
    const report = { checks, checkedAt: now.toISOString() };
    await this.domains.update(row.id, {
      status: next.status,
      dnsReport: report,
      attempts: row.attempts + 1,
      lastCheckedAt: now,
      nextCheckAt: next.nextCheckAt,
    });
    let status = next.status;
    if (
      status === 'verified' &&
      (await this.commands.attachLiveHostname(row.organizationId, row.siteId, row.hostname))
    ) {
      await this.domains.update(row.id, { status: 'active' });
      status = 'active';
    }
    return { ...row, status, dnsReport: report, attempts: row.attempts + 1, lastCheckedAt: now };
  }

  /** After a site goes live: its verified domains are served at once. */
  async activateForSite(organizationId: string, siteId: string): Promise<void> {
    for (const row of await this.domains.forSite(organizationId, siteId))
      if (
        row.status === 'verified' &&
        (await this.commands.attachLiveHostname(organizationId, siteId, row.hostname))
      )
        await this.domains.update(row.id, { status: 'active' });
  }

  /** Caddy's on-demand TLS `ask`: a certificate only for a verified or active name, with the right token. */
  async allow(hostname: string | undefined, token: string | undefined): Promise<boolean> {
    const expected = (this.env as ApiEnv).DOMAIN_ASK_TOKEN;
    if (!expected || !token || !hostname) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const row = await this.domains.byHostname(hostname.trim().toLowerCase().replace(/\.$/, ''));
    return row?.status === 'verified' || row?.status === 'active';
  }
}
