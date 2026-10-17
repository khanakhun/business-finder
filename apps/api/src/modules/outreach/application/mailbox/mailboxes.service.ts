import { lookup } from 'node:dns/promises';
import {
  type Clock,
  type ConnectSmtpMailboxRequest,
  ConnectSmtpMailboxRequestSchema,
  ForbiddenError,
  type Locale,
  type MailboxDetail,
  MailboxDisconnected,
  MailboxHealthSchema,
  type MailboxLastError,
  MailboxRampSchema,
  type MailboxTestResult,
  NotFoundError,
  newId,
  SendWindowSchema,
  type UpdateMailboxRequest,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { Transactional } from '../../../platform/db/transactional.ts';
import { EventRecorder } from '../../../platform/events/event-recorder.ts';
import { LOGGER, type Logger } from '../../../platform/logging/logger.ts';
import { isPublicAddress } from '../../../platform/security/ip-policy.ts';
import { MailboxProviderError } from '../../domain/mailbox/errors.ts';
import { buildTestMessage } from '../../domain/mailbox/test-message.ts';
import { isValidTimeZone } from '../../domain/mailbox/zoned-time.ts';
import { MailboxCredentialStore } from './mailbox-credentials.ts';
import { MailboxLifecycle } from './mailbox-lifecycle.ts';
import { mailboxDay, toMailbox, toMailboxEvent, usageSeries } from './mailbox-view.ts';
import {
  CAPACITY_COUNTERS,
  type CapacityCounters,
  MAILBOX_LIMITS,
  MAILBOX_PROVIDERS,
  MAILBOX_REPOSITORY,
  type MailboxCtx,
  type MailboxLimits,
  type MailboxPatch,
  type MailboxProviderRegistry,
  type MailboxRecord,
  type MailboxRepository,
  OAUTH_CLIENTS,
  type OAuthClientRegistry,
  SMTP_CONNECTION_TESTER,
  type SmtpConnectionTester,
} from './ports.ts';
import { oauthProviderOf, TokenRefresher } from './token-refresher.ts';

// Mailbox use cases (BF-050): connect (SMTP/IMAP here, OAuth in `mailbox-oauth.ts`), settings, pause/resume with a
// health check, a test send to the person's own address, and disconnect (vault secret purged, history kept).

export interface MailboxActor {
  readonly organizationId: string;
  readonly userId: string | null;
  readonly email: string | null;
  readonly locale: Locale;
  /** `settings:manage`: shared mailboxes, other people's mailboxes, caps, ramp and windows. */
  readonly manage: boolean;
}

const SEND_TEST_TIMEOUT_MS = 30_000;

@Injectable()
export class MailboxesService {
  constructor(
    @Inject(MAILBOX_REPOSITORY) private readonly repository: MailboxRepository,
    @Inject(MAILBOX_PROVIDERS) private readonly providers: MailboxProviderRegistry,
    @Inject(CAPACITY_COUNTERS) private readonly counters: CapacityCounters,
    @Inject(SMTP_CONNECTION_TESTER) private readonly smtpTester: SmtpConnectionTester,
    @Inject(MAILBOX_LIMITS) private readonly limits: MailboxLimits,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(OAUTH_CLIENTS) private readonly oauthClients: OAuthClientRegistry,
    private readonly credentials: MailboxCredentialStore,
    private readonly lifecycle: MailboxLifecycle,
    private readonly events: EventRecorder,
    private readonly tokens: TokenRefresher,
  ) {}

  async list(actor: MailboxActor) {
    const now = this.clock.now();
    const mailboxes = (await this.repository.list(actor.organizationId)).filter(
      (m) => m.disconnectedAt === null,
    );
    return { items: await Promise.all(mailboxes.map((mailbox) => this.view(mailbox, now))) };
  }

  async get(actor: MailboxActor, id: string): Promise<MailboxDetail> {
    const mailbox = await this.load(actor, id);
    const now = this.clock.now();
    const today = mailboxDay(mailbox, now);
    const fromDay = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    const [usage, events] = await Promise.all([
      this.repository.usage(mailbox.id, fromDay, today),
      this.repository.events(actor.organizationId, mailbox.id, 50),
    ]);
    return {
      mailbox: await this.view(mailbox, now),
      usage: usageSeries(mailbox, usage, now),
      events: events.map(toMailboxEvent),
    };
  }

  /** SMTP + IMAP: validated by a live connection test before anything is saved; the password goes to the vault. */
  async connectSmtp(actor: MailboxActor, input: ConnectSmtpMailboxRequest) {
    const request = ConnectSmtpMailboxRequestSchema.parse(input);
    if (request.shared && !actor.manage)
      throw new ForbiddenError('Only admins can connect a shared mailbox.');
    for (const host of [request.smtp.host, request.imap?.host]) if (host) await this.assertHostAllowed(host);
    const tested = await this.smtpTester.test(request);
    if (!tested.ok)
      throw new ValidationError(
        'Could not connect with these settings.',
        [{ path: ['smtp'], message: tested.error }],
        {
          details: { reason: 'CONNECTION_FAILED' },
        },
      );
    const providerState = {
      smtp: request.smtp,
      ...(request.imap ? { imap: request.imap } : {}),
      username: request.username,
      appendToSent: request.imap ? request.appendToSent : false,
      ...(tested.sentFolder ? { sentFolder: tested.sentFolder } : {}),
    };
    const mailbox = await this.save(actor, {
      provider: 'smtp_imap',
      email: request.email,
      displayName: request.displayName,
      shared: request.shared,
      providerState,
      credentials: { kind: 'password', username: request.username, password: request.password },
    });
    return this.view(mailbox, this.clock.now());
  }

  /**
   * Creates the mailbox (or reconnects the existing one with that address), stores its credentials and starts it:
   * `connected` → `warming` with the ramp from today (or `active` when the ramp is off).
   */
  @Transactional()
  async save(
    actor: MailboxActor,
    input: {
      readonly provider: MailboxRecord['provider'];
      readonly email: string;
      readonly displayName: string;
      readonly shared: boolean;
      readonly providerState: MailboxRecord['providerState'];
      readonly credentials: Parameters<MailboxCredentialStore['put']>[2];
      readonly mailboxId?: string;
    },
  ): Promise<MailboxRecord> {
    const now = this.clock.now();
    const existing = input.mailboxId
      ? await this.load(actor, input.mailboxId)
      : await this.repository.findByEmail(actor.organizationId, input.email);
    if (existing && existing.disconnectedAt === null && existing.status !== 'error')
      throw new ValidationError(
        'This mailbox is already connected.',
        [{ path: ['email'], message: 'Already connected' }],
        {
          details: { reason: 'ALREADY_CONNECTED' },
        },
      );
    if (existing) this.assertCanEdit(actor, existing);
    const id = existing?.id ?? newId();
    const secretRef = await this.credentials.put(actor.organizationId, id, input.credentials, actor.userId);
    const ownerUserId = input.shared ? null : actor.userId;
    let mailbox: MailboxRecord;
    if (existing) {
      mailbox = await this.repository.update(actor.organizationId, id, {
        secretRef,
        providerState: input.providerState,
        lastError: null,
        disconnectedAt: null,
        displayName: input.displayName,
        ramp: { ...existing.ramp, startedAt: existing.ramp.startedAt ?? now.toISOString() },
      });
      if (mailbox.status === 'error')
        mailbox = await this.lifecycle.transition(mailbox, 'connected', {
          reason: 'reconnected',
          automatic: false,
          actorUserId: actor.userId,
        });
    } else {
      const maxCap = this.limits.maxDailyCap[input.provider];
      const ramp = MailboxRampSchema.parse({});
      mailbox = await this.repository.insert({
        id,
        organizationId: actor.organizationId,
        ownerUserId,
        provider: input.provider,
        email: input.email.toLowerCase(),
        displayName: input.displayName,
        status: 'connected',
        dailyCap: Math.min(ramp.maxCap, maxCap),
        ramp: { ...ramp, maxCap: Math.min(ramp.maxCap, maxCap), startedAt: now.toISOString() },
        window: SendWindowSchema.parse({}),
        minIntervalSec: 90,
        locales: [actor.locale],
        providerState: input.providerState,
        health: MailboxHealthSchema.parse({
          checkedAt: null,
          tokenOk: null,
          reachable: null,
          quotaOk: null,
          sendTestOk: null,
          dns: null,
        }),
        secretRef,
      });
      await this.repository.addEvent(actor.organizationId, id, {
        kind: 'connected',
        fromStatus: null,
        toStatus: 'connected',
        detail: { provider: input.provider },
        actorUserId: actor.userId,
      });
    }
    return this.lifecycle.transition(mailbox, this.lifecycle.sendingStatus(mailbox), {
      reason: mailbox.ramp.enabled ? 'ramp started' : null,
      automatic: true,
      actorUserId: actor.userId,
    });
  }

  @Transactional()
  async update(actor: MailboxActor, id: string, patch: UpdateMailboxRequest) {
    const mailbox = await this.load(actor, id);
    this.assertCanEdit(actor, mailbox);
    const limited = ['dailyCap', 'ramp', 'window', 'minIntervalSec'] as const;
    if (!actor.manage && limited.some((key) => patch[key] !== undefined))
      throw new ForbiddenError('Only admins can change caps, the ramp and sending windows.');
    const max = this.limits.maxDailyCap[mailbox.provider];
    const errors: { path: string[]; message: string }[] = [];
    if (patch.dailyCap !== undefined && patch.dailyCap > max)
      errors.push({ path: ['dailyCap'], message: `At most ${max} for this provider` });
    if (patch.ramp?.maxCap !== undefined && patch.ramp.maxCap > max)
      errors.push({ path: ['ramp', 'maxCap'], message: `At most ${max} for this provider` });
    if (patch.window?.mailboxTimezone !== undefined && !isValidTimeZone(patch.window.mailboxTimezone))
      errors.push({ path: ['window', 'mailboxTimezone'], message: 'Unknown time zone' });
    if (errors.length > 0) throw new ValidationError('Some settings are not allowed.', errors);
    const changes: MailboxPatch = {
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.dailyCap !== undefined ? { dailyCap: patch.dailyCap } : {}),
      ...(patch.ramp !== undefined
        ? {
            ramp: {
              ...MailboxRampSchema.parse(patch.ramp),
              startedAt: patch.ramp.startedAt ?? mailbox.ramp.startedAt ?? this.clock.now().toISOString(),
            },
          }
        : {}),
      ...(patch.window !== undefined ? { window: SendWindowSchema.parse(patch.window) } : {}),
      ...(patch.minIntervalSec !== undefined ? { minIntervalSec: patch.minIntervalSec } : {}),
      ...(patch.locales !== undefined ? { locales: [...new Set(patch.locales)] } : {}),
      ...(patch.signatureMd !== undefined ? { signatureMd: patch.signatureMd } : {}),
      ...(patch.replyTo !== undefined ? { replyTo: patch.replyTo } : {}),
    };
    let updated = await this.repository.update(actor.organizationId, id, changes);
    await this.repository.addEvent(actor.organizationId, id, {
      kind: 'settings_changed',
      fromStatus: null,
      toStatus: null,
      detail: { fields: Object.keys(changes) },
      actorUserId: actor.userId,
    });
    // A new ramp may move a sending mailbox between warming and active.
    if (updated.status === 'warming' || updated.status === 'active') {
      const target = this.lifecycle.sendingStatus(updated);
      if (target !== updated.status)
        updated = await this.lifecycle.transition(updated, target, {
          reason: 'ramp changed',
          automatic: true,
          actorUserId: actor.userId,
        });
    }
    return this.view(updated, this.clock.now());
  }

  @Transactional()
  async pause(actor: MailboxActor, id: string, reason: string | undefined) {
    const mailbox = await this.load(actor, id);
    this.assertCanEdit(actor, mailbox);
    const paused = await this.lifecycle.transition(mailbox, 'paused', {
      reason: reason?.trim() || 'paused manually',
      automatic: false,
      actorUserId: actor.userId,
    });
    return this.view(paused, this.clock.now());
  }

  /** Resuming needs a passing health check (token, reachability, quota). */
  async resume(actor: MailboxActor, id: string) {
    const mailbox = await this.load(actor, id);
    this.assertCanEdit(actor, mailbox);
    if (mailbox.status !== 'paused')
      throw new ValidationError('Only a paused mailbox can be resumed.', [], {
        details: { reason: 'NOT_PAUSED' },
      });
    const report = await this.checkHealth(mailbox);
    if (!report.ok)
      throw new ValidationError('The mailbox did not pass its health check.', [], {
        details: { reason: 'HEALTH_CHECK_FAILED', error: report.error },
      });
    return this.resumeChecked(actor, report.mailbox);
  }

  @Transactional()
  private async resumeChecked(actor: MailboxActor, mailbox: MailboxRecord) {
    const resumed = await this.lifecycle.transition(mailbox, this.lifecycle.sendingStatus(mailbox), {
      reason: 'resumed',
      automatic: false,
      actorUserId: actor.userId,
    });
    return this.view(resumed, this.clock.now());
  }

  /** A test message to the person's own address (not counted against outreach capacity). */
  async sendTest(actor: MailboxActor, id: string): Promise<MailboxTestResult> {
    const mailbox = await this.load(actor, id);
    this.assertCanEdit(actor, mailbox);
    if (!actor.email) throw new ForbiddenError('A test needs a signed-in person with an email address.');
    const provider = this.provider(mailbox);
    const messageId = `<${newId()}@${mailbox.email.split('@')[1] ?? 'localhost'}>`;
    const mime = buildTestMessage({
      from: { name: mailbox.displayName, email: mailbox.email },
      to: actor.email,
      messageId,
      date: this.clock.now(),
      locale: actor.locale === 'fr' ? 'fr' : 'en',
    });
    try {
      const sent = await provider.sendRaw(this.ctx(mailbox), mime, {
        signal: AbortSignal.timeout(SEND_TEST_TIMEOUT_MS),
      });
      await this.repository.addEvent(actor.organizationId, id, {
        kind: 'test_sent',
        fromStatus: null,
        toStatus: null,
        detail: { ok: true },
        actorUserId: actor.userId,
      });
      return { ok: true, to: actor.email, rfc822MessageId: sent.rfc822MessageId, error: null };
    } catch (error) {
      const failure = await this.recordProviderError(mailbox, error);
      await this.repository.addEvent(actor.organizationId, id, {
        kind: 'test_sent',
        fromStatus: null,
        toStatus: null,
        detail: { ok: false, code: failure.code },
        actorUserId: actor.userId,
      });
      return { ok: false, to: actor.email, rfc822MessageId: null, error: failure.message };
    }
  }

  /** Disconnect: the vault secret is purged and the provider consent revoked where possible; history is kept. */
  @Transactional()
  async disconnect(actor: MailboxActor, id: string): Promise<void> {
    const mailbox = await this.load(actor, id);
    this.assertCanEdit(actor, mailbox);
    const errored =
      mailbox.status === 'error'
        ? mailbox
        : await this.lifecycle.transition(mailbox, 'error', {
            reason: 'disconnected',
            automatic: false,
            actorUserId: actor.userId,
          });
    await this.revoke(mailbox);
    await this.credentials.delete(actor.organizationId, id);
    await this.repository.update(actor.organizationId, id, {
      secretRef: null,
      disconnectedAt: this.clock.now(),
      providerState: {},
    });
    await this.repository.addEvent(actor.organizationId, id, {
      kind: 'disconnected',
      fromStatus: errored.status,
      toStatus: errored.status,
      detail: {},
      actorUserId: actor.userId,
    });
    await this.events.record(MailboxDisconnected, {
      orgId: actor.organizationId,
      payload: { mailboxId: id, email: mailbox.email },
    });
  }

  /** Revokes an OAuth grant where the provider supports it (best effort: the vault entry goes anyway). */
  private async revoke(mailbox: MailboxRecord): Promise<void> {
    const provider = oauthProviderOf(mailbox.provider);
    const client = provider ? this.oauthClients.get(provider) : undefined;
    if (!client?.configured) return;
    try {
      const stored = await this.credentials.get(mailbox.organizationId, mailbox.id);
      if (stored?.kind === 'oauth') await client.revoke(stored.refreshToken);
    } catch (error) {
      this.logger.warn({ err: error, mailboxId: mailbox.id }, 'could not revoke the mailbox grant');
    }
  }

  /** Runs the provider's health check and records it; an authentication failure puts the mailbox in `error`. */
  async checkHealth(
    mailbox: MailboxRecord,
  ): Promise<{ ok: boolean; mailbox: MailboxRecord; error: MailboxLastError | null }> {
    const now = this.clock.now();
    let report: Awaited<ReturnType<ReturnType<MailboxesService['provider']>['checkHealth']>>;
    try {
      report = await this.provider(mailbox).checkHealth(this.ctx(mailbox));
    } catch (error) {
      const failure = await this.recordProviderError(mailbox, error);
      return {
        ok: false,
        mailbox: (await this.repository.find(mailbox.organizationId, mailbox.id)) ?? mailbox,
        error: failure,
      };
    }
    const health = {
      ...mailbox.health,
      checkedAt: now.toISOString(),
      tokenOk: report.tokenOk,
      reachable: report.reachable,
      quotaOk: report.quotaOk,
    };
    const lastError = report.error ? { ...report.error, at: now.toISOString() } : mailbox.lastError;
    const updated = await this.repository.update(mailbox.organizationId, mailbox.id, { health, lastError });
    if (report.error)
      await this.recordProviderError(
        updated,
        new MailboxProviderError(mailbox.provider, report.error.code, report.error.message),
      );
    const ok = report.tokenOk && report.reachable && report.quotaOk;
    return { ok, mailbox: updated, error: ok ? null : lastError };
  }

  /** The mailbox context a provider works with; credentials are read from the vault only when used. */
  ctx(mailbox: MailboxRecord): MailboxCtx {
    return {
      id: mailbox.id,
      organizationId: mailbox.organizationId,
      email: mailbox.email,
      providerState: mailbox.providerState,
      credentials: async () => {
        const credentials = await this.credentials.get(mailbox.organizationId, mailbox.id);
        if (!credentials)
          throw new MailboxProviderError(mailbox.provider, 'auth_failed', 'No stored credentials');
        return credentials;
      },
      accessToken: () => this.tokens.accessToken(mailbox),
    };
  }

  provider(mailbox: MailboxRecord) {
    const provider = this.providers.get(mailbox.provider);
    if (!provider) throw new MailboxProviderError(mailbox.provider, 'unknown', 'Provider not available');
    return provider;
  }

  /**
   * Records a provider failure (credential-free) and applies the lifecycle: authentication lost → `error`, quota
   * exhausted → `paused`. Returns what the person is shown.
   */
  async recordProviderError(mailbox: MailboxRecord, error: unknown): Promise<MailboxLastError> {
    const at = this.clock.now().toISOString();
    const failure: MailboxLastError =
      error instanceof MailboxProviderError
        ? { code: error.reason, message: error.message.slice(0, 300), at }
        : { code: 'unknown', message: 'The provider call failed', at };
    this.logger.warn({ mailboxId: mailbox.id, code: failure.code }, 'mailbox provider call failed');
    await this.repository.update(mailbox.organizationId, mailbox.id, { lastError: failure });
    await this.repository.addEvent(mailbox.organizationId, mailbox.id, {
      kind: 'error',
      fromStatus: null,
      toStatus: null,
      detail: { code: failure.code },
      actorUserId: null,
    });
    const target =
      failure.code === 'auth_failed' || failure.code === 'consent_revoked'
        ? 'error'
        : failure.code === 'quota_exceeded'
          ? 'paused'
          : null;
    if (target && mailbox.status !== target && mailbox.status !== 'error') {
      try {
        await this.lifecycle.transition(mailbox, target, {
          reason: failure.message,
          automatic: true,
          actorUserId: null,
        });
      } catch (transitionError) {
        this.logger.warn(
          { err: transitionError, mailboxId: mailbox.id },
          'mailbox transition after error failed',
        );
      }
    }
    return failure;
  }

  private async view(mailbox: MailboxRecord, now: Date) {
    const day = mailboxDay(mailbox, now);
    const [counters, rows] = await Promise.all([
      this.counters.today(mailbox.id, day),
      this.repository.usage(mailbox.id, day, day),
    ]);
    const row = rows[0];
    return toMailbox(
      mailbox,
      {
        sent: Math.max(counters?.sent ?? 0, row?.sent ?? 0),
        failed: row?.failed ?? 0,
        bounced: row?.bounced ?? 0,
        reserved: counters?.reserved ?? 0,
      },
      now,
    );
  }

  /** A mailbox the actor may change (owner or admin), or 403/404. */
  async editable(actor: MailboxActor, id: string): Promise<MailboxRecord> {
    const mailbox = await this.load(actor, id);
    this.assertCanEdit(actor, mailbox);
    return mailbox;
  }

  private async load(actor: MailboxActor, id: string): Promise<MailboxRecord> {
    const mailbox = await this.repository.find(actor.organizationId, id);
    if (!mailbox || mailbox.disconnectedAt !== null) throw new NotFoundError('Mailbox', id);
    return mailbox;
  }

  private assertCanEdit(actor: MailboxActor, mailbox: MailboxRecord): void {
    if (actor.manage) return;
    if (mailbox.ownerUserId === null || mailbox.ownerUserId !== actor.userId)
      throw new ForbiddenError('Only the mailbox owner or an admin can change this mailbox.');
  }

  /** TLS is required except on the development hosts (Mailpit); private addresses are refused in production. */
  private async assertHostAllowed(host: string): Promise<void> {
    const lower = host.toLowerCase();
    if (!this.limits.production && this.limits.insecureHosts.includes(lower)) return;
    if (!this.limits.production) return;
    let addresses: { address: string }[];
    try {
      addresses = await lookup(lower, { all: true });
    } catch {
      throw new ValidationError('This host could not be resolved.', [
        { path: ['smtp', 'host'], message: 'Unknown host' },
      ]);
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address)))
      throw new ValidationError('This host is not allowed.', [
        { path: ['smtp', 'host'], message: 'Not a public host' },
      ]);
  }
}
