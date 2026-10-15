import type { ApiEnv } from '@bf/config';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { APP_ENV, type AppEnv, type AppMode } from '../platform/config/app-env.ts';
import { InMemoryObjectStorage, OBJECT_STORAGE } from '../platform/storage/object-storage.ts';
import { S3ObjectStorage } from '../platform/storage/s3-object-storage.ts';
import { AuditLogger } from './application/audit-logger.ts';
import { ListAuditLogsQuery } from './application/audit-logs.query.ts';
import { ConnectionTesterRegistry } from './application/connection-testers.ts';
import { FeatureFlagService } from './application/feature-flags.service.ts';
import {
  AUDIT_LOG_REPOSITORY,
  DEPLOYMENT_ENV,
  MASTER_KEY_PROVIDER,
  ORG_SETTINGS_REPOSITORY,
  SECRETS_REPOSITORY,
} from './application/ports.ts';
import { SecretResolver } from './application/secret-resolver.ts';
import {
  DeleteSecretCommand,
  ListSecretsQuery,
  PutSecretCommand,
  SecretSummaries,
  TestSecretCommand,
} from './application/secrets.use-cases.ts';
import { SecretsVault } from './application/secrets-vault.ts';
import { GetSettingsQuery, LogoUseCases, UpdateSettingsCommand } from './application/settings.use-cases.ts';
import { WorkspaceReadiness } from './application/workspace-readiness.ts';
import { DrizzleAuditLogRepository } from './infrastructure/drizzle-audit-log.repository.ts';
import { DrizzleOrgSettingsRepository } from './infrastructure/drizzle-org-settings.repository.ts';
import { DrizzleSecretsRepository } from './infrastructure/drizzle-secrets.repository.ts';
import { EnvMasterKeyProvider } from './infrastructure/env-master-key.provider.ts';
import { registerFakeConnectionTesters } from './infrastructure/fake-connection-testers.ts';
import { AuditLogsController } from './interface/http/audit-logs.controller.ts';
import { AuditInterceptor } from './interface/http/audited.interceptor.ts';
import { SecretsController } from './interface/http/secrets.controller.ts';
import { WorkspaceSettingsController } from './interface/http/workspace-settings.controller.ts';

/** Services other modules use (see index.ts): audit, secrets, feature flags, readiness. */
const PUBLIC = [
  AuditLogger,
  SecretsVault,
  SecretResolver,
  ConnectionTesterRegistry,
  FeatureFlagService,
  WorkspaceReadiness,
] as const;

/**
 * Workspace (BF-011): settings, encrypted secrets vault, audit log, feature flags. Global so every module can audit
 * and resolve secrets without importing it (it depends only on platform).
 */
@Module({})
export class WorkspaceModule {
  static forRoot(mode: AppMode): DynamicModule {
    const providers: Provider[] = [
      { provide: ORG_SETTINGS_REPOSITORY, useClass: DrizzleOrgSettingsRepository },
      { provide: SECRETS_REPOSITORY, useClass: DrizzleSecretsRepository },
      { provide: AUDIT_LOG_REPOSITORY, useClass: DrizzleAuditLogRepository },
      {
        provide: MASTER_KEY_PROVIDER,
        inject: [APP_ENV],
        useFactory: (env: AppEnv) => new EnvMasterKeyProvider(env as ApiEnv),
      },
      { provide: DEPLOYMENT_ENV, inject: [APP_ENV], useFactory: (env: AppEnv) => env },
      {
        provide: ConnectionTesterRegistry,
        inject: [SecretResolver, APP_ENV],
        useFactory: (resolver: SecretResolver, env: AppEnv) => {
          const registry = new ConnectionTesterRegistry(resolver);
          if ((env as ApiEnv).FAKE_CONNECTION_TESTS) {
            if (env.NODE_ENV === 'production')
              throw new Error('FAKE_CONNECTION_TESTS is refused in production');
            registerFakeConnectionTesters(registry);
          }
          return registry;
        },
      },
      ...PUBLIC.filter((service) => service !== ConnectionTesterRegistry),
    ];
    if (mode === 'worker') return { module: WorkspaceModule, global: true, providers, exports: [...PUBLIC] };
    return {
      module: WorkspaceModule,
      global: true,
      controllers: [WorkspaceSettingsController, SecretsController, AuditLogsController],
      providers: [
        ...providers,
        {
          provide: OBJECT_STORAGE,
          inject: [APP_ENV],
          // OpenAPI generation connects to nothing.
          useFactory: (env: AppEnv) =>
            mode === 'openapi' ? new InMemoryObjectStorage() : new S3ObjectStorage(env as ApiEnv),
        },
        AuditInterceptor,
        GetSettingsQuery,
        UpdateSettingsCommand,
        LogoUseCases,
        SecretSummaries,
        ListSecretsQuery,
        PutSecretCommand,
        DeleteSecretCommand,
        TestSecretCommand,
        ListAuditLogsQuery,
      ],
      exports: [...PUBLIC],
    };
  }
}
