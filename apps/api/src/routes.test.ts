import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.ts';
import { loadAppEnv } from './modules/platform/config/app-env.ts';
import { ACCESS_POLICY, type AccessPolicy } from './modules/platform/security/auth.decorators.ts';

interface Route {
  readonly controller: string;
  readonly handler: string;
  readonly policy: AccessPolicy | undefined;
}

let routes: Route[] = [];
let close: () => Promise<void>;

// Boots the HTTP wiring with no infrastructure (openapi mode) and lists every controller handler.
beforeAll(async () => {
  const app = await NestFactory.create(AppModule.forOpenApi(loadAppEnv('openapi')), { logger: false });
  close = () => app.close();
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (!type) continue;
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        const handler = type.prototype[name as keyof object] as unknown;
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        const policy =
          (Reflect.getMetadata(ACCESS_POLICY, handler) as AccessPolicy | undefined) ??
          (Reflect.getMetadata(ACCESS_POLICY, type) as AccessPolicy | undefined);
        routes.push({ controller: type.name, handler: name, policy });
      }
    }
  }
});

afterAll(async () => {
  await close();
  routes = [];
});

// Public routes, reviewed. Adding one means updating this list and apps/api/README.md#anonymous-routes.
const ANONYMOUS = [
  'HealthController.live',
  'IdentityConfigController.get',
  'HealthController.ready',
  'MetricsController.scrape',
  'PublicSiteViewsController.record',
  // BF-048: preview lead forms (proof of work, anti-spam, CORS to the sites domain, no IP stored).
  'PublicLeadsController.challenge',
  'PublicLeadsController.submit',
  // BF-055: the privacy page's data-subject request form (site token, rate limits, always "received").
  'PublicDsrController.submit',
  // BF-050: the OAuth redirect back from Google/Microsoft (signed single-use state, PKCE, server-side attempt).
  'MailboxOAuthController.callback',
  // BF-055: RFC 8058 one-click and the human unsubscribe page (token only; same answer for unknown tokens).
  'PublicUnsubscribeController.oneClick',
  'UnsubscribePageController.show',
  'UnsubscribePageController.confirm',
  'SystemController.info',
  // BF-062: the contact routing confirmation link (the emailed token is the proof; same answer when unknown).
  'PublicContactRoutingController.confirm',
  // BF-062: Caddy's on-demand TLS ask (a shared token in the URL; verified domains only; never routed publicly).
  'InternalDomainsController.allow',
];

describe('route access policies (AGENTS.md §8)', () => {
  it('finds the controllers', () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it('every route declares one (a route without a policy would be refused at runtime)', () => {
    expect(routes.filter((r) => !r.policy).map((r) => `${r.controller}.${r.handler}`)).toEqual([]);
  });

  it('anonymous routes are exactly the reviewed list', () => {
    const anonymous = routes
      .filter((r) => r.policy?.kind === 'anonymous')
      .map((r) => `${r.controller}.${r.handler}`);
    expect(anonymous.sort()).toEqual([...ANONYMOUS].sort());
  });

  it('cross-workspace tools are operator-only', () => {
    const operator = routes
      .filter((r) => r.policy?.kind === 'operator')
      .map((r) => `${r.controller}.${r.handler}`);
    expect(operator).toEqual(['SystemController.ping']);
  });

  it('routes without a workspace are limited to the caller acting on themselves', () => {
    const orgless = routes
      .filter((r) => r.policy?.kind === 'authenticated' && !r.policy.orgRequired)
      .map((r) => `${r.controller}.${r.handler}`);
    // The client portal (BF-062): a business owner has no workspace; each handler checks their site grant.
    expect(orgless.sort()).toEqual(
      [
        'MeController.me',
        'ClientPortalController.sites',
        'ClientPortalController.site',
        'ClientPortalController.stats',
        'ClientPortalController.leads',
        'ClientPortalController.upload',
        'ClientPortalController.changeRequests',
        'ClientPortalController.createChangeRequest',
        'ClientPortalController.approvals',
        'ClientPortalController.decide',
      ].sort(),
    );
  });
});
