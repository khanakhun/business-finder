import type { Permission, Role } from '@bf/contracts';
import type { Request } from 'express';

/**
 * Who is calling, resolved once per request from the session cookie or an `Authorization: Bearer bf_…` API key
 * (identity module). Organization context comes only from here — never from bodies or paths (api.md §2).
 */
export interface AuthContext {
  readonly method: 'session' | 'api_key';
  /** The signed-in user; null for API keys (actions are attributed to the key). */
  readonly userId: string | null;
  readonly apiKeyId: string | null;
  /** Active organization (session) or owning organization (API key); null = no workspace selected. */
  readonly orgId: string | null;
  /** Role in `orgId` (sessions only). */
  readonly role: Role | null;
  readonly permissions: ReadonlySet<Permission>;
  /** Session requests with an unsafe method whose Origin/Referer is not the app (CSRF defence, security.md §1). */
  readonly crossOrigin: boolean;
  /**
   * Platform operator (PLATFORM_OPERATOR_EMAILS, verified session only): may use cross-workspace tools such as Bull
   * Board. Unrelated to workspace roles — a workspace owner is not an operator.
   */
  readonly operator: boolean;
}

/** Result of resolving a request: authenticated, anonymous, or presented invalid credentials (always 401). */
export type AuthResolution =
  | { readonly kind: 'authenticated'; readonly auth: AuthContext }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Resolves credentials; provided by the identity module, used by the Express middleware in http.ts. */
export interface AuthResolver {
  resolve(req: Request): Promise<AuthResolution>;
}

export const AUTH_RESOLVER = Symbol('AUTH_RESOLVER');

const RESOLUTION = Symbol('bf.auth');

type RequestWithAuth = Request & { [RESOLUTION]?: AuthResolution };

export function setRequestAuth(req: Request, resolution: AuthResolution): void {
  (req as RequestWithAuth)[RESOLUTION] = resolution;
}

/** Anonymous when nothing resolved the request (e.g. a test app without the identity module). */
export function getRequestAuth(req: Request): AuthResolution {
  return (req as RequestWithAuth)[RESOLUTION] ?? { kind: 'anonymous' };
}
