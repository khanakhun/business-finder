import type { OAuthClient, OAuthTokens } from '../../../application/mailbox/ports.ts';
import { form, providerFetch } from '../http.ts';

// Google OAuth 2.0 for Gmail/Workspace mailboxes (BF-050). Scopes: `gmail.send` (sensitive) and `gmail.readonly`
// (restricted, for reply sync). DECISION(BF-050): deploy the OAuth client as **Internal** to the agency's Workspace —
// restricted scopes then need no external verification; domain-wide delegation is the alternative (admin-configured).

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

interface TokenBody {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly scope?: string;
}

export class GoogleOAuthClient implements OAuthClient {
  readonly provider = 'google' as const;
  readonly kind = 'gmail' as const;

  constructor(
    private readonly clientId: string | undefined,
    private readonly clientSecret: string | undefined,
    private readonly redirectUri: string,
    private readonly now: () => Date,
  ) {}

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  authorizeUrl(input: { state: string; codeChallenge: string; loginHint?: string }) {
    const params = new URLSearchParams({
      client_id: this.clientId ?? '',
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPES.join(' '),
      access_type: 'offline',
      // Always ask: Google returns a refresh token only on consent.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      ...(input.loginHint ? { login_hint: input.loginHint } : {}),
    });
    return `${AUTHORIZE}?${params}`;
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
      'gmail',
      'mailbox-api',
      TOKEN,
      form({
        code,
        code_verifier: codeVerifier,
        client_id: this.clientId ?? '',
        client_secret: this.clientSecret ?? '',
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
    );
    return this.tokens(body as TokenBody);
  }

  async refresh(refreshToken: string) {
    const { body } = await providerFetch(
      'gmail',
      'mailbox-api',
      TOKEN,
      form({
        refresh_token: refreshToken,
        client_id: this.clientId ?? '',
        client_secret: this.clientSecret ?? '',
        grant_type: 'refresh_token',
      }),
    );
    return this.tokens(body as TokenBody);
  }

  async revoke(token: string) {
    await providerFetch('gmail', 'mailbox-api', REVOKE, form({ token }));
  }

  async profile(accessToken: string) {
    const { body } = await providerFetch('gmail', 'mailbox-api', PROFILE, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const email = String((body as { emailAddress?: string }).emailAddress ?? '').toLowerCase();
    return { email, displayName: email.split('@')[0] ?? email };
  }
}
