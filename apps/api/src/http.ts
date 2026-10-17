import { AUTH_BASE_PATH } from '@bf/auth';
import type { ApiEnv } from '@bf/config';
import { LOGO_MAX_BYTES, SITE_SPEC_MAX_BYTES } from '@bf/contracts';
import type { Logger } from '@bf/observability';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { json, type NextFunction, type Request, type Response, raw, urlencoded } from 'express';
import helmet from 'helmet';
import { type Auth, BETTER_AUTH } from './modules/identity/infrastructure/better-auth.provider.ts';
import { betterAuthMiddleware } from './modules/identity/infrastructure/better-auth-http.ts';
import { siteOrigin } from './modules/leads/interface/sites-origin.ts';
import type { AppEnv } from './modules/platform/config/app-env.ts';
import { LOGGER } from './modules/platform/logging/logger.ts';
import {
  AUTH_RESOLVER,
  type AuthResolver,
  getRequestAuth,
  setRequestAuth,
} from './modules/platform/security/auth-context.ts';

/** A provider of the identity module, or undefined when the app was composed without it. */
function optional<T>(app: INestApplication, token: symbol): T | undefined {
  try {
    return app.get<T>(token, { strict: false });
  } catch {
    return undefined;
  }
}

/**
 * Resolves the session cookie / API key once per request, before Nest's middleware, guards and Bull Board, so
 * all of them see the same caller (`getRequestAuth`). A failed check is treated as invalid credentials (401 on
 * protected routes), never as anonymous access.
 */
function resolveCredentials(resolver: AuthResolver, logger: Logger | undefined) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.path.startsWith(`${AUTH_BASE_PATH}/`)) {
      next();
      return;
    }
    resolver.resolve(req).then(
      (resolution) => {
        setRequestAuth(req, resolution);
        next();
      },
      (error: unknown) => {
        logger?.error({ err: error }, 'credential check failed');
        setRequestAuth(req, { kind: 'invalid', reason: 'credential check failed' });
        next();
      },
    );
  };
}

/** HTTP-level setup shared by main.ts, openapi.ts and tests, so they all see the same routes. */
export function configureHttp(app: INestApplication, env: AppEnv): void {
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
      // Operator dashboard (Bull Board): not part of the versioned REST API.
      { path: 'admin/queues', method: RequestMethod.ALL },
      { path: 'admin/queues/{*path}', method: RequestMethod.ALL },
      // The human unsubscribe page (BF-055): short links in every message footer.
      { path: 'u/:token', method: RequestMethod.GET },
      { path: 'u/:token', method: RequestMethod.POST },
    ],
  });
  app.use(helmet());
  // The dashboard is the only browser origin with credentials. Preview sites (BF-048) may call the two anonymous lead
  // routes from `<slug>.<SITES_BASE_DOMAIN>`, without credentials.
  const sitesDomain = (env as Partial<ApiEnv>).SITES_BASE_DOMAIN;
  app.enableCors(
    (req: Request, callback: (error: Error | null, options: Record<string, unknown>) => void) => {
      const path = req.url ?? '';
      if (
        sitesDomain &&
        (path.startsWith('/v1/public/sites/leads') || path.startsWith('/v1/public/sites/altcha-challenge'))
      ) {
        callback(null, {
          origin: siteOrigin(req.headers.origin, sitesDomain) !== null,
          credentials: false,
          methods: ['GET', 'POST'],
          allowedHeaders: ['Content-Type'],
          maxAge: 600,
        });
        return;
      }
      callback(null, { origin: [env.APP_URL], credentials: true });
    },
  );
  // Registered before app.init(), so these run ahead of Nest's body parsers: Better Auth reads the raw body.
  const auth = optional<Auth>(app, BETTER_AUTH);
  if (auth) app.use(betterAuthMiddleware(auth, (env as Partial<ApiEnv>).AUTH_TRUSTED_PROXIES ?? []));
  const resolver = optional<AuthResolver>(app, AUTH_RESOLVER);
  if (resolver) app.use(resolveCredentials(resolver, optional<Logger>(app, LOGGER)));
  // Logo uploads are raw image bodies (Nest only parses JSON and forms), read only for authenticated PUTs. The
  // use case enforces the real limit with a clear 422; this cap only stops oversized bodies early (413).
  const logoBody = raw({ type: () => true, limit: LOGO_MAX_BYTES * 2 });
  app.use('/v1/workspace/logo', (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'PUT' && getRequestAuth(req).kind === 'authenticated') logoBody(req, res, next);
    else next();
  });
  // The sites' view beacon (BF-036) sends its JSON as text/plain: a simple cross-origin request, no preflight (the
  // renderer never reads the answer). Only this anonymous route reads that type, and only a small body.
  // (Wrapped: Nest skips its own JSON parser when it finds a middleware named `jsonParser` on the app.)
  const beaconBody = json({ type: ['application/json', 'text/plain'], limit: '2kb' });
  app.use('/v1/public/sites/views', (req: Request, res: Response, next: NextFunction) =>
    beaconBody(req, res, next),
  );
  // Lead forms of preview sites (BF-048): JSON from the enhanced form, or a plain form post without JavaScript; small.
  const leadJson = json({ limit: '16kb' });
  const leadForm = urlencoded({ extended: false, limit: '16kb' });
  app.use('/v1/public/sites/leads', (req: Request, res: Response, next: NextFunction) =>
    leadJson(req, res, (error?: unknown) => (error ? next(error) : leadForm(req, res, next))),
  );
  // Site specs are larger than Nest's 100 kB JSON default: the sites routes take a whole spec (the use case refuses
  // one over the cap with a 422 at its path); an authenticated request only, parsed once (Nest's parser skips it).
  const siteBody = json({ limit: SITE_SPEC_MAX_BYTES + 64 * 1024 });
  app.use('/v1/sites', (req: Request, res: Response, next: NextFunction) => {
    if (getRequestAuth(req).kind === 'authenticated') siteBody(req, res, next);
    else next();
  });
}
