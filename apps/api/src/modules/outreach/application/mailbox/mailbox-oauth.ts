import { type Clock, ForbiddenError, type OAuthMailboxProvider, ValidationError } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { LOGGER, type Logger } from '../../../platform/logging/logger.ts';
import { newNonce, pkcePair, signState, verifyState } from '../../domain/mailbox/oauth-state.ts';
import { type MailboxActor, MailboxesService } from './mailboxes.service.ts';
import {
  OAUTH_ATTEMPTS,
  OAUTH_CLIENTS,
  OAUTH_SETTINGS,
  type OAuthAttemptStore,
  type OAuthClientRegistry,
  type OAuthSettings,
} from './ports.ts';

// Connecting Gmail/Workspace and Microsoft 365 mailboxes (BF-050): authorization code flow with PKCE and a signed,
// single-use state carrying nothing but a nonce; tokens go straight to the vault. The callback is reached by the
// provider's redirect (no session), so everything it trusts comes from the stored attempt.

const ATTEMPT_TTL_SECONDS = 600;

@Injectable()
export class MailboxOAuth {
  constructor(
    @Inject(OAUTH_CLIENTS) private readonly clients: OAuthClientRegistry,
    @Inject(OAUTH_ATTEMPTS) private readonly attempts: OAuthAttemptStore,
    @Inject(OAUTH_SETTINGS) private readonly settings: OAuthSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly mailboxes: MailboxesService,
  ) {}

  async start(
    actor: MailboxActor,
    provider: OAuthMailboxProvider,
    options: { readonly shared: boolean; readonly mailboxId?: string | undefined },
  ): Promise<{ url: string }> {
    const client = this.clients.get(provider);
    if (!client?.configured)
      throw new ValidationError(
        `Connecting ${provider} mailboxes is not configured on this deployment.`,
        [],
        {
          details: { reason: 'OAUTH_NOT_CONFIGURED', provider },
        },
      );
    if (!actor.userId) throw new ForbiddenError('Connecting a mailbox needs a signed-in person.');
    if (options.shared && !actor.manage)
      throw new ForbiddenError('Only admins can connect a shared mailbox.');
    let loginHint: string | undefined;
    if (options.mailboxId) {
      const mailbox = await this.mailboxes.editable(actor, options.mailboxId);
      if (mailbox.provider !== client.kind)
        throw new ValidationError('This mailbox uses another provider.', [], {
          details: { reason: 'WRONG_PROVIDER' },
        });
      loginHint = mailbox.email;
    }
    const { verifier, challenge } = pkcePair();
    const nonce = newNonce();
    await this.attempts.put(
      nonce,
      {
        provider,
        organizationId: actor.organizationId,
        userId: actor.userId,
        shared: options.shared,
        manage: actor.manage,
        mailboxId: options.mailboxId ?? null,
        codeVerifier: verifier,
        locale: actor.locale,
      },
      ATTEMPT_TTL_SECONDS,
    );
    const state = signState(
      nonce,
      this.clock.now().getTime() + ATTEMPT_TTL_SECONDS * 1000,
      this.settings.stateKey,
    );
    return {
      url: client.authorizeUrl({ state, codeChallenge: challenge, ...(loginHint ? { loginHint } : {}) }),
    };
  }

  /** Returns where to send the browser: the mailbox settings with the outcome. */
  async callback(
    provider: OAuthMailboxProvider,
    query: {
      readonly code?: string | undefined;
      readonly state?: string | undefined;
      readonly error?: string | undefined;
    },
  ): Promise<string> {
    const back = (params: Record<string, string>) =>
      `${this.settings.returnUrl}?${new URLSearchParams(params)}`;
    const fail = (reason: string) => back({ oauth: 'error', provider, reason });
    if (query.error) return fail(query.error === 'access_denied' ? 'denied' : 'provider_error');
    if (!query.code || !query.state) return fail('invalid_request');
    const nonce = verifyState(query.state, this.clock.now().getTime(), this.settings.stateKey);
    const attempt = nonce ? await this.attempts.take(nonce) : null;
    if (!attempt || attempt.provider !== provider) return fail('expired');
    const client = this.clients.get(provider);
    if (!client?.configured) return fail('not_configured');
    try {
      const tokens = await client.exchange(query.code, attempt.codeVerifier);
      if (!tokens.refreshToken) return fail('no_offline_access');
      const profile = await client.profile(tokens.accessToken);
      const actor: MailboxActor = {
        organizationId: attempt.organizationId,
        userId: attempt.userId,
        email: null,
        locale: attempt.locale,
        manage: attempt.manage,
      };
      if (attempt.mailboxId) {
        const existing = await this.mailboxes.editable(actor, attempt.mailboxId);
        if (existing.email.toLowerCase() !== profile.email.toLowerCase()) return fail('wrong_account');
      }
      const mailbox = await this.mailboxes.save(actor, {
        provider: client.kind,
        email: profile.email,
        displayName: profile.displayName,
        shared: attempt.shared,
        providerState: {},
        credentials: {
          kind: 'oauth',
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt.toISOString(),
          scope: tokens.scope,
        },
        ...(attempt.mailboxId ? { mailboxId: attempt.mailboxId } : {}),
      });
      // The first health check right away (best effort: the hourly sweep repeats it).
      await this.mailboxes.checkHealth(mailbox).catch((error: unknown) => {
        this.logger.warn({ err: error, mailboxId: mailbox.id }, 'first mailbox health check failed');
      });
      return back({ oauth: 'connected', provider, mailbox: mailbox.id });
    } catch (error) {
      this.logger.warn({ err: error, provider }, 'mailbox OAuth callback failed');
      const reason = (error as { details?: { reason?: string } }).details?.reason;
      return fail(reason === 'ALREADY_CONNECTED' ? 'already_connected' : 'exchange_failed');
    }
  }
}
