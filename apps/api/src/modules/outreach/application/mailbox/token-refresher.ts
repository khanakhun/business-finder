import type { Clock } from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { MailboxProviderError } from '../../domain/mailbox/errors.ts';
import { MailboxCredentialStore } from './mailbox-credentials.ts';
import {
  type MailboxRecord,
  OAUTH_CLIENTS,
  type OAuthClientRegistry,
  REFRESH_LOCK,
  type RefreshLock,
} from './ports.ts';

// Access tokens for OAuth mailboxes (BF-050): reused until a minute before expiry, then refreshed by exactly one
// process (Valkey lock); the others wait for the new token in the vault. A refused refresh is a revoked consent.

const EARLY_MS = 60_000;
const WAIT_STEPS_MS = [250, 500, 1_000, 2_000, 4_000];

export const oauthProviderOf = (kind: MailboxRecord['provider']) =>
  kind === 'gmail' ? ('google' as const) : kind === 'graph' ? ('microsoft' as const) : null;

@Injectable()
export class TokenRefresher {
  constructor(
    @Inject(OAUTH_CLIENTS) private readonly clients: OAuthClientRegistry,
    @Inject(REFRESH_LOCK) private readonly lock: RefreshLock,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly credentials: MailboxCredentialStore,
  ) {}

  async accessToken(mailbox: Pick<MailboxRecord, 'id' | 'organizationId' | 'provider'>): Promise<string> {
    const fresh = await this.current(mailbox);
    if (fresh) return fresh;
    const refreshed = await this.lock.withLock(
      mailbox.id,
      async () => (await this.current(mailbox)) ?? this.refresh(mailbox),
    );
    if (refreshed) return refreshed;
    for (const delay of WAIT_STEPS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const token = await this.current(mailbox);
      if (token) return token;
    }
    throw new MailboxProviderError(mailbox.provider, 'unreachable', 'Timed out waiting for a token refresh');
  }

  private async current(mailbox: Pick<MailboxRecord, 'id' | 'organizationId' | 'provider'>) {
    const stored = await this.credentials.get(mailbox.organizationId, mailbox.id);
    if (!stored || stored.kind !== 'oauth')
      throw new MailboxProviderError(mailbox.provider, 'auth_failed', 'No OAuth credentials stored');
    if (
      stored.accessToken &&
      stored.expiresAt &&
      Date.parse(stored.expiresAt) - EARLY_MS > this.clock.now().getTime()
    )
      return stored.accessToken;
    return null;
  }

  private async refresh(mailbox: Pick<MailboxRecord, 'id' | 'organizationId' | 'provider'>): Promise<string> {
    const provider = oauthProviderOf(mailbox.provider);
    const client = provider ? this.clients.get(provider) : undefined;
    if (!client?.configured)
      throw new MailboxProviderError(mailbox.provider, 'auth_failed', 'The OAuth client is not configured');
    const stored = await this.credentials.get(mailbox.organizationId, mailbox.id);
    if (!stored || stored.kind !== 'oauth')
      throw new MailboxProviderError(mailbox.provider, 'auth_failed', 'No OAuth credentials stored');
    const tokens = await client.refresh(stored.refreshToken);
    await this.credentials.put(
      mailbox.organizationId,
      mailbox.id,
      {
        ...stored,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? stored.refreshToken,
        expiresAt: tokens.expiresAt.toISOString(),
        scope: tokens.scope ?? stored.scope,
      },
      null,
    );
    return tokens.accessToken;
  }
}
