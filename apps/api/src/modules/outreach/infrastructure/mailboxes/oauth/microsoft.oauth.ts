import type { OAuthClient, OAuthTokens } from '../../../application/mailbox/ports.ts';
import { form, providerFetch } from '../http.ts';

// Microsoft identity platform (v2.0) for Microsoft 365 mailboxes (BF-050): delegated `Mail.Send`, `Mail.ReadWrite`
// (the draft-then-send path that returns `internetMessageId`, and delta sync), `User.Read` (the address) and
// `offline_access` (refresh tokens). Plain OAuth endpoints rather than MSAL: refresh tokens are kept in the vault.

export const GRAPH_SCOPES = ['offline_access', 'Mail.Send', 'Mail.ReadWrite', 'User.Read'] as const;

interface TokenBody {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly scope?: string;
}

export class MicrosoftOAuthClient implements OAuthClient {
  readonly provider = 'microsoft' as const;
  readonly kind = 'graph' as const;

  constructor(
    private readonly clientId: string | undefined,
    private readonly clientSecret: string | undefined,
    private readonly tenant: string,
    private readonly redirectUri: string,
    private readonly now: () => Date,
  ) {}

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  private endpoint(path: 'authorize' | 'token') {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/${path}`;
  }

  authorizeUrl(input: { state: string; codeChallenge: string; loginHint?: string }) {
    const params = new URLSearchParams({
      client_id: this.clientId ?? '',
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: GRAPH_SCOPES.join(' '),
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
      ...(input.loginHint ? { login_hint: input.loginHint } : {}),
    });
    return `${this.endpoint('authorize')}?${params}`;
  }

  private tokens(body: TokenBody): OAuthTokens {
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: new Date(this.now().getTime() + body.expires_in * 1000),
      scope: body.scope ?? null,
    };
  }

  async exchange(code: string, codeVerifier: string) {
    const { body } = await providerFetch(
      'graph',
      'mailbox-api',
      this.endpoint('token'),
      form({
        client_id: this.clientId ?? '',
        client_secret: this.clientSecret ?? '',
        scope: GRAPH_SCOPES.join(' '),
        code,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
    );
    return this.tokens(body as TokenBody);
  }

  async refresh(refreshToken: string) {
    const { body } = await providerFetch(
      'graph',
      'mailbox-api',
      this.endpoint('token'),
      form({
        client_id: this.clientId ?? '',
        client_secret: this.clientSecret ?? '',
        scope: GRAPH_SCOPES.join(' '),
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    );
    return this.tokens(body as TokenBody);
  }

  /** Microsoft has no per-grant revocation for a delegated refresh token; the vault entry is purged instead. */
  async revoke() {}

  async profile(accessToken: string) {
    const { body } = await providerFetch(
      'graph',
      'mailbox-api',
      'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName',
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    const me = body as { mail?: string | null; userPrincipalName?: string; displayName?: string };
    const email = String(me.mail ?? me.userPrincipalName ?? '').toLowerCase();
    return { email, displayName: me.displayName?.trim() || email };
  }
}
