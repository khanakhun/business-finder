import type {
  Locale,
  MailboxHealth,
  MailboxLastError,
  MailboxProviderKind,
  MailboxProviderState,
  MailboxRamp,
  MailboxStatus,
  SendWindow,
} from '@bf/contracts';

// Ports of the mailboxes (BF-050). Providers move raw MIME and raw inbound messages; composition (BF-052) and
// threading/triage (BF-054) live elsewhere.

export interface MailboxRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerUserId: string | null;
  readonly provider: MailboxProviderKind;
  readonly email: string;
  readonly displayName: string;
  readonly status: MailboxStatus;
  readonly statusReason: string | null;
  readonly dailyCap: number;
  readonly ramp: MailboxRamp;
  readonly window: SendWindow;
  readonly minIntervalSec: number;
  readonly locales: Locale[];
  readonly signatureMd: string;
  readonly replyTo: string | null;
  readonly secretRef: string | null;
  readonly providerState: MailboxProviderState;
  readonly health: MailboxHealth;
  readonly lastError: MailboxLastError | null;
  readonly lastSelectedAt: Date | null;
  readonly disconnectedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NewMailbox = Pick<
  MailboxRecord,
  | 'organizationId'
  | 'ownerUserId'
  | 'provider'
  | 'email'
  | 'displayName'
  | 'status'
  | 'dailyCap'
  | 'ramp'
  | 'window'
  | 'minIntervalSec'
  | 'locales'
  | 'providerState'
  | 'health'
> & { readonly id: string; readonly secretRef: string | null };

export type MailboxPatch = Partial<
  Pick<
    MailboxRecord,
    | 'displayName'
    | 'dailyCap'
    | 'ramp'
    | 'window'
    | 'minIntervalSec'
    | 'locales'
    | 'signatureMd'
    | 'replyTo'
    | 'secretRef'
    | 'providerState'
    | 'health'
    | 'lastError'
    | 'lastSelectedAt'
    | 'disconnectedAt'
    | 'ownerUserId'
  >
>;

export interface MailboxUsageRow {
  readonly day: string;
  readonly sent: number;
  readonly failed: number;
  readonly bounced: number;
  readonly complaints: number;
  readonly replies: number;
}

export interface MailboxEventRow {
  readonly id: string;
  readonly kind: string;
  readonly fromStatus: MailboxStatus | null;
  readonly toStatus: MailboxStatus | null;
  readonly detail: Record<string, unknown>;
  readonly actorUserId: string | null;
  readonly createdAt: Date;
}

export interface MailboxRepository {
  list(organizationId: string): Promise<MailboxRecord[]>;
  find(organizationId: string, id: string): Promise<MailboxRecord | undefined>;
  findByEmail(organizationId: string, email: string): Promise<MailboxRecord | undefined>;
  insert(mailbox: NewMailbox): Promise<MailboxRecord>;
  update(organizationId: string, id: string, patch: MailboxPatch): Promise<MailboxRecord>;
  /** Compare-and-set on the status; false when it changed meanwhile. */
  setStatus(
    organizationId: string,
    id: string,
    from: MailboxStatus,
    to: MailboxStatus,
    reason: string | null,
  ): Promise<boolean>;
  addEvent(
    organizationId: string,
    mailboxId: string,
    event: Omit<MailboxEventRow, 'id' | 'createdAt'>,
  ): Promise<void>;
  events(organizationId: string, mailboxId: string, limit: number): Promise<MailboxEventRow[]>;
  usage(mailboxId: string, fromDay: string, toDay: string): Promise<MailboxUsageRow[]>;
  addUsage(mailboxId: string, day: string, delta: Partial<Omit<MailboxUsageRow, 'day'>>): Promise<void>;
  /** Bounces / sent per mailbox since `fromDay` (the selector's bounce signal). */
  bounceRates(organizationId: string, fromDay: string): Promise<Map<string, number>>;
  /** Connected mailboxes of every workspace, by id after `afterId` (the hourly health check). */
  listForHealth(limit: number, afterId?: string): Promise<MailboxRecord[]>;
  delete(organizationId: string, id: string): Promise<boolean>;
}
export const MAILBOX_REPOSITORY = Symbol('MailboxRepository');

// ── Credentials (vault) ──────────────────────────────────────────────────────────────────────────────────────────

export type MailboxCredentials =
  | { readonly kind: 'password'; readonly username: string; readonly password: string }
  | {
      readonly kind: 'oauth';
      readonly refreshToken: string;
      readonly accessToken: string | null;
      /** ISO instant the access token expires. */
      readonly expiresAt: string | null;
      readonly scope: string | null;
      /** Microsoft: the serialized MSAL token cache and the account id. */
      readonly msalCache?: string;
      readonly homeAccountId?: string;
    };

// ── Providers ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MailboxCtx {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly providerState: MailboxProviderState;
  /** Resolves the credentials just in time; never logged. */
  readonly credentials: () => Promise<MailboxCredentials>;
  /** OAuth mailboxes: a valid access token (refreshed single-flight when about to expire). */
  readonly accessToken: () => Promise<string>;
}

export type SyncCursor =
  | { readonly kind: 'imap'; readonly uidValidity: string; readonly lastUid: number }
  | { readonly kind: 'gmail'; readonly historyId: string }
  | { readonly kind: 'graph'; readonly deltaLink: string };

export interface RawInbound {
  readonly providerMessageId: string;
  readonly providerThreadId: string | null;
  readonly rfc822MessageId: string | null;
  readonly headers: Readonly<Record<string, string[]>>;
  /** The full RFC 822 source when the provider gives it. */
  readonly raw: Buffer | null;
  readonly receivedAt: Date | null;
}

export interface PushSubscription {
  readonly id: string;
  readonly expiresAt: Date;
}

export interface HealthReport {
  readonly tokenOk: boolean;
  readonly reachable: boolean;
  readonly quotaOk: boolean;
  readonly error: { readonly code: MailboxLastError['code']; readonly message: string } | null;
}

export interface SendResult {
  readonly providerMessageId: string;
  readonly rfc822MessageId: string;
  readonly providerThreadId?: string;
}

/** What the outbound reconciler (BF-052) looks for in the mailbox's sent items after an unknown send outcome. */
export interface SentProbe {
  /** The Message-ID we put in the message (providers may have replaced it). */
  readonly rfc822MessageId: string;
  /** Our `X-BF-Outbound-Id` header: confirms a candidate found by recipient and time. */
  readonly outboundId: string;
  readonly to: string;
  readonly subject: string;
  /** The attempt started then (candidates sent earlier are not ours). */
  readonly since: Date;
}

export interface MailboxProvider {
  readonly kind: MailboxProviderKind;
  readonly capabilities: { readonly push: boolean; readonly threads: boolean; readonly rawMime: boolean };
  sendRaw(
    mailbox: MailboxCtx,
    mime: Buffer,
    options: { readonly threadHint?: string; readonly signal: AbortSignal },
  ): Promise<SendResult>;
  /**
   * The message in the sent items, or null when it is not there. Throws when the provider cannot tell (then the
   * pipeline must not resend).
   */
  findSent(mailbox: MailboxCtx, probe: SentProbe, signal: AbortSignal): Promise<SendResult | null>;
  syncChanges(
    mailbox: MailboxCtx,
    cursor: SyncCursor | null,
  ): Promise<{ readonly messages: RawInbound[]; readonly next: SyncCursor }>;
  ensurePush?(mailbox: MailboxCtx): Promise<PushSubscription>;
  checkHealth(mailbox: MailboxCtx): Promise<HealthReport>;
}
export const MAILBOX_PROVIDERS = Symbol('MailboxProviders');
export type MailboxProviderRegistry = ReadonlyMap<MailboxProviderKind, MailboxProvider>;

/** Tests an SMTP + IMAP account before it is saved (the live connection test). */
export interface SmtpConnectionTester {
  test(input: {
    readonly smtp: { readonly host: string; readonly port: number; readonly security: 'starttls' | 'tls' };
    readonly imap?:
      | { readonly host: string; readonly port: number; readonly security: 'starttls' | 'tls' }
      | undefined;
    readonly username: string;
    readonly password: string;
  }): Promise<
    { readonly ok: true; readonly sentFolder: string | null } | { readonly ok: false; readonly error: string }
  >;
}
export const SMTP_CONNECTION_TESTER = Symbol('SmtpConnectionTester');

// ── Capacity counters (Valkey) ───────────────────────────────────────────────────────────────────────────────────

export type ReserveRefusal = 'MAILBOX_CAP' | 'WORKSPACE_CAP' | 'DOMAIN_LIMIT' | 'UNSEEDED';

export interface ReserveInput {
  readonly organizationId: string;
  readonly mailboxId: string;
  /** The mailbox's day (its timezone). */
  readonly day: string;
  readonly cap: number;
  /** The workspace's UTC day and cap. */
  readonly workspaceDay: string;
  readonly workspaceCap: number;
  readonly recipientDomain: string;
  readonly domainHour: string;
  readonly domainLimit: number;
  /** A reservation not committed or released within this time is dropped. */
  readonly ttlSeconds: number;
}

export interface CapacityCounters {
  reserve(input: ReserveInput): Promise<{ ok: true; token: string } | { ok: false; reason: ReserveRefusal }>;
  /** Idempotent: true only the first time a token is committed. */
  commit(token: string): Promise<{ readonly mailboxId: string; readonly day: string } | null>;
  release(token: string): Promise<boolean>;
  /** Seeds the mailbox's sent count for the day from the database (no-op when present). */
  seed(mailboxId: string, day: string, sent: number): Promise<void>;
  today(mailboxId: string, day: string): Promise<{ readonly sent: number; readonly reserved: number } | null>;
  /** The last send instant of a mailbox (spacing between sends). */
  lastSentAt(mailboxId: string): Promise<Date | null>;
  noteSent(mailboxId: string, at: Date): Promise<void>;
}
export const CAPACITY_COUNTERS = Symbol('CapacityCounters');

export interface MailboxLimits {
  readonly maxDailyCap: Readonly<Record<MailboxProviderKind, number>>;
  readonly workspaceDailyCap: number;
  readonly domainHourlyLimit: number;
  readonly insecureHosts: readonly string[];
  readonly production: boolean;
  readonly seedAddress: string | null;
}
export const MAILBOX_LIMITS = Symbol('MailboxLimits');

/** A cross-process lock (one health sweep at a time across workers). */
export interface RunLock {
  acquire(name: string, ttlSeconds: number): Promise<boolean>;
}
export const RUN_LOCK = Symbol('RunLock');

// ── OAuth (Google, Microsoft) ────────────────────────────────────────────────────────────────────────────────────

export interface OAuthTokens {
  readonly accessToken: string;
  /** Null when the provider kept the previous one. */
  readonly refreshToken: string | null;
  readonly expiresAt: Date;
  readonly scope: string | null;
}

export interface OAuthClient {
  readonly provider: 'google' | 'microsoft';
  readonly kind: MailboxProviderKind;
  readonly configured: boolean;
  authorizeUrl(input: {
    readonly state: string;
    readonly codeChallenge: string;
    readonly loginHint?: string;
  }): string;
  exchange(code: string, codeVerifier: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  /** Best effort: revoke the grant when the provider supports it. */
  revoke(token: string): Promise<void>;
  /** The connected account's address and name. */
  profile(accessToken: string): Promise<{ readonly email: string; readonly displayName: string }>;
}
export const OAUTH_CLIENTS = Symbol('OAuthClients');
export type OAuthClientRegistry = ReadonlyMap<'google' | 'microsoft', OAuthClient>;

/** One OAuth attempt, kept server-side for 10 minutes and usable once (the PKCE verifier never leaves the API). */
export interface OAuthAttempt {
  readonly provider: 'google' | 'microsoft';
  readonly organizationId: string;
  readonly userId: string;
  readonly shared: boolean;
  /** The starter had `settings:manage` (checked when the attempt began). */
  readonly manage: boolean;
  readonly mailboxId: string | null;
  readonly codeVerifier: string;
  readonly locale: Locale;
}

export interface OAuthAttemptStore {
  put(nonce: string, attempt: OAuthAttempt, ttlSeconds: number): Promise<void>;
  /** Returns and deletes it (single use). */
  take(nonce: string): Promise<OAuthAttempt | null>;
}
export const OAUTH_ATTEMPTS = Symbol('OAuthAttemptStore');

/** Single-flight access-token refresh across processes. */
export interface RefreshLock {
  /** Runs `fn` holding the mailbox's refresh lock, or returns null when another process holds it. */
  withLock<T>(mailboxId: string, fn: () => Promise<T>): Promise<T | null>;
}
export const REFRESH_LOCK = Symbol('RefreshLock');

export interface OAuthSettings {
  /** `${API_URL}/v1/mailboxes/oauth/:provider/callback` */
  readonly callbackUrl: (provider: 'google' | 'microsoft') => string;
  /** Where the browser lands afterwards: the dashboard's mailbox settings. */
  readonly returnUrl: string;
  /** HMAC key for the `state` parameter. */
  readonly stateKey: string;
}
export const OAUTH_SETTINGS = Symbol('OAuthSettings');
