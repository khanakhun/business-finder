import type { ApiEnv } from '@bf/config';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { AUTH_RESOLVER } from '../platform/security/auth-context.ts';
import {
  CreateApiKeyCommand,
  ListApiKeysQuery,
  RevokeApiKeyCommand,
} from './application/api-keys.commands.ts';
import { GetMeQuery } from './application/get-me.query.ts';
import {
  InvitationMailer,
  InviteMemberCommand,
  ResendInvitationCommand,
  RevokeInvitationCommand,
} from './application/invitations.commands.ts';
import { ListMembersQuery } from './application/members.query.ts';
import {
  ChangeMemberRoleCommand,
  RemoveMemberCommand,
  TransferOwnershipCommand,
} from './application/membership.commands.ts';
import {
  API_KEY_ISSUER,
  API_KEY_REPOSITORY,
  APP_URL,
  IDENTITY_EVENTS,
  MEMBERSHIP_REPOSITORY,
  SYSTEM_MAILER,
} from './application/ports.ts';
import { BETTER_AUTH, betterAuthProvider } from './infrastructure/better-auth.provider.ts';
import { BetterAuthApiKeyIssuer } from './infrastructure/better-auth-api-key-issuer.ts';
import { BetterAuthResolver } from './infrastructure/better-auth-resolver.ts';
import { DrizzleApiKeyRepository } from './infrastructure/drizzle-api-key.repository.ts';
import { DrizzleMembershipRepository } from './infrastructure/drizzle-membership.repository.ts';
import { LoggingIdentityEvents } from './infrastructure/logging-identity-events.ts';
import { SmtpSystemMailer } from './infrastructure/smtp-system-mailer.ts';
import { ApiKeysController } from './interface/http/api-keys.controller.ts';
import { MeController } from './interface/http/me.controller.ts';
import { MembersController } from './interface/http/members.controller.ts';

/**
 * Identity (ADR-0007): Better Auth (mounted at /api/auth by http.ts), credential resolution for every request,
 * `/v1/me`, members & invitations, API keys. HTTP-only: the worker has no use for sessions.
 */
@Module({})
export class IdentityModule {
  static forRoot(mode: AppMode): DynamicModule {
    if (mode === 'worker') return { module: IdentityModule };
    return {
      module: IdentityModule,
      controllers: [MeController, MembersController, ApiKeysController],
      providers: [
        betterAuthProvider,
        { provide: AUTH_RESOLVER, useClass: BetterAuthResolver },
        { provide: MEMBERSHIP_REPOSITORY, useClass: DrizzleMembershipRepository },
        { provide: API_KEY_REPOSITORY, useClass: DrizzleApiKeyRepository },
        { provide: API_KEY_ISSUER, useClass: BetterAuthApiKeyIssuer },
        { provide: SYSTEM_MAILER, useClass: SmtpSystemMailer },
        { provide: IDENTITY_EVENTS, useClass: LoggingIdentityEvents },
        { provide: APP_URL, inject: [APP_ENV], useFactory: (env: AppEnv) => (env as ApiEnv).APP_URL },
        GetMeQuery,
        ListMembersQuery,
        InvitationMailer,
        InviteMemberCommand,
        ResendInvitationCommand,
        RevokeInvitationCommand,
        ChangeMemberRoleCommand,
        RemoveMemberCommand,
        TransferOwnershipCommand,
        ListApiKeysQuery,
        CreateApiKeyCommand,
        RevokeApiKeyCommand,
      ],
      exports: [BETTER_AUTH, AUTH_RESOLVER],
    };
  }
}
