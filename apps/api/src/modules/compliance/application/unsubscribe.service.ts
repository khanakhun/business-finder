import {
  type Clock,
  type IssueUnsubscribeRequest,
  IssueUnsubscribeRequestSchema,
  type UnsubscribeChoice,
  UnsubscribeConfirmed,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import { EventRecorder } from '../../platform/events/event-recorder.ts';
import { LOGGER, type Logger } from '../../platform/logging/logger.ts';
import { SecretsVault, WorkspaceDefaults } from '../../workspace/index.ts';
import { normalizeKey } from '../domain/normalizers.ts';
import {
  hashToken,
  isTokenShaped,
  maskEmail,
  newUnsubscribeToken,
  privacyHash,
  UNSUBSCRIBE_TTL_DAYS,
} from '../domain/unsubscribe-token.ts';
import { ComplianceService } from './compliance.service.ts';
import {
  UNSUBSCRIBE_SETTINGS,
  UNSUBSCRIBE_TOKEN_REPOSITORY,
  type UnsubscribeSettings,
  type UnsubscribeTokenRepository,
  type UnsubscribeTokenRow,
} from './ports.ts';

// Unsubscribe (BF-055, RFC 8058). `issue` is called by the outbound pipeline for every message and fails closed (no
// token, no send). The one-click POST suppresses the address at once; the human page never acts on GET (link
// scanners prefetch) and offers: this address, the whole business (do-not-contact), and removing the preview.
// Unknown and expired tokens get the same generic answer as valid ones.

const SEAL_PURPOSE = 'unsubscribe.email';

export interface IssuedUnsubscribe {
  readonly token: string;
  /** The human page (footer link). */
  readonly pageUrl: string;
  /** The `List-Unsubscribe` URL (RFC 8058 one-click POST target). */
  readonly oneClickUrl: string;
  readonly mailtoUrl: string | null;
}

export interface UnsubscribePageModel {
  readonly locale: 'en' | 'fr';
  readonly maskedEmail: string;
  readonly hasBusiness: boolean;
  readonly agency: Awaited<ReturnType<WorkspaceDefaults['identity']>>;
  readonly alreadyUsed: boolean;
}

@Injectable()
export class UnsubscribeService {
  constructor(
    @Inject(UNSUBSCRIBE_TOKEN_REPOSITORY) private readonly tokens: UnsubscribeTokenRepository,
    @Inject(UNSUBSCRIBE_SETTINGS) private readonly settings: UnsubscribeSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly vault: SecretsVault,
    private readonly workspace: WorkspaceDefaults,
    private readonly compliance: ComplianceService,
    private readonly events: EventRecorder,
  ) {}

  /** A new token for one message (throws on any failure: the caller must not send without one). */
  async issue(organizationId: string, input: IssueUnsubscribeRequest): Promise<IssuedUnsubscribe> {
    const request = IssueUnsubscribeRequestSchema.parse(input);
    const email = normalizeKey('email', request.email);
    if (!email)
      throw new ValidationError('Not a valid email address.', [{ path: ['email'], message: 'Invalid' }]);
    const token = newUnsubscribeToken();
    const now = this.clock.now();
    await this.tokens.insert({
      tokenHash: hashToken(token),
      organizationId,
      contactId: request.contactId,
      emailSealed: this.vault.sealValue(organizationId, SEAL_PURPOSE, email),
      emailHash: privacyHash(this.settings.pepper, 'email', email),
      businessId: request.businessId,
      outboundMessageId: request.outboundMessageId,
      locale: request.locale,
      expiresAt: new Date(now.getTime() + UNSUBSCRIBE_TTL_DAYS * 86_400_000),
    });
    return {
      token,
      pageUrl: `${this.settings.baseUrl}/u/${token}`,
      oneClickUrl: `${this.settings.baseUrl}/v1/public/unsubscribe/${token}`,
      mailtoUrl: null,
    };
  }

  /** The valid token's row (unexpired), or null — callers answer the same either way. */
  private async lookup(token: string): Promise<UnsubscribeTokenRow | null> {
    const row = await this.tokens.findByHash(hashToken(isTokenShaped(token) ? token : `invalid:${token}`));
    if (!row || row.expiresAt.getTime() < this.clock.now().getTime()) return null;
    return row;
  }

  /** RFC 8058 one-click: suppress the address now (idempotent). Unknown tokens are only logged. */
  async oneClick(token: string): Promise<void> {
    const row = await this.lookup(token);
    if (!row) {
      this.logger.info({ event: 'unsubscribe.unknown_token' }, 'one-click unsubscribe with an unknown token');
      return;
    }
    await this.apply(row, ['address'], true);
  }

  /** The human page's content (null for an unknown or expired token: the page then shows a generic message). */
  async page(token: string): Promise<UnsubscribePageModel | null> {
    const row = await this.lookup(token);
    if (!row) return null;
    const email = this.vault.openValue(row.organizationId, SEAL_PURPOSE, row.emailSealed);
    return {
      locale: row.locale,
      maskedEmail: maskEmail(email),
      hasBusiness: row.businessId !== null,
      agency: await this.workspace.identity(row.organizationId),
      alreadyUsed: row.usedAt !== null,
    };
  }

  /** The page's form: what the person chose (always at least this address). */
  async confirm(token: string, choices: readonly UnsubscribeChoice[]): Promise<UnsubscribePageModel | null> {
    const row = await this.lookup(token);
    if (!row) return null;
    const chosen = new Set<UnsubscribeChoice>(['address', ...choices]);
    if (!row.businessId) {
      chosen.delete('business');
      chosen.delete('preview');
    }
    await this.apply(row, [...chosen], false);
    return this.page(token);
  }

  @Transactional()
  private async apply(
    row: UnsubscribeTokenRow,
    choices: UnsubscribeChoice[],
    oneClick: boolean,
  ): Promise<void> {
    const email = this.vault.openValue(row.organizationId, SEAL_PURPOSE, row.emailSealed);
    const actor = { type: 'system', id: 'compliance.unsubscribe' } as const;
    await this.compliance.suppress({
      organizationId: row.organizationId,
      scope: 'email',
      value: email,
      reason: 'unsubscribe',
      source: oneClick ? 'one_click' : 'link',
      actor,
    });
    if (choices.includes('business') && row.businessId)
      await this.compliance.suppress({
        organizationId: row.organizationId,
        scope: 'org_business',
        value: row.businessId,
        reason: 'opt_out',
        source: 'link',
        actor,
      });
    if (!row.usedAt) await this.tokens.markUsed(row.id, this.clock.now());
    // Do-not-contact and taking the preview down are the CRM's and the sites' (subscribers of this event).
    await this.events.record(UnsubscribeConfirmed, {
      orgId: row.organizationId,
      actor,
      payload: {
        tokenId: row.id,
        businessId: (row.businessId ?? null) as never,
        outboundMessageId: row.outboundMessageId,
        choices,
        oneClick,
      },
    });
  }
}
