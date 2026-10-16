import {
  type Clock,
  NotFoundError,
  SECRET_NAMES,
  type SecretList,
  type SecretName,
  type SecretSummary,
  type SecretTestResult,
  secretDefinition,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import { Transactional } from '../../platform/db/transactional.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { AuditLogger } from './audit-logger.ts';
import { ConnectionTesterRegistry } from './connection-testers.ts';
import type { SecretMetadata } from './ports.ts';
import { SecretResolver } from './secret-resolver.ts';
import { SecretsVault } from './secrets-vault.ts';
import { workspaceOf } from './settings.use-cases.ts';

@Injectable()
export class SecretSummaries {
  constructor(
    private readonly resolver: SecretResolver,
    private readonly testers: ConnectionTesterRegistry,
  ) {}

  /** Metadata only: never the value (security.md §2). */
  summary(name: SecretName, stored: SecretMetadata | undefined): SecretSummary {
    const definition = secretDefinition(name);
    return {
      name,
      provider: definition.provider,
      description: definition.description,
      source: stored ? 'workspace' : this.resolver.hasGlobal(name) ? 'global' : null,
      last4: stored?.last4 ?? null,
      updatedAt: stored?.updatedAt.toISOString() ?? null,
      lastUsedAt: stored?.lastUsedAt?.toISOString() ?? null,
      allowGlobalFallback: definition.allowGlobalFallback,
      testable: this.testers.has(name),
    };
  }
}

@Injectable()
export class ListSecretsQuery {
  constructor(
    private readonly vault: SecretsVault,
    private readonly summaries: SecretSummaries,
  ) {}

  async execute(auth: AuthContext): Promise<SecretList> {
    const stored = new Map((await this.vault.list(workspaceOf(auth))).map((row) => [row.name, row]));
    return { items: SECRET_NAMES.map((name) => this.summaries.summary(name, stored.get(name))) };
  }
}

@Injectable()
export class PutSecretCommand {
  constructor(
    private readonly vault: SecretsVault,
    private readonly summaries: SecretSummaries,
    private readonly audit: AuditLogger,
  ) {}

  @Transactional()
  async execute(auth: AuthContext, name: SecretName, value: string): Promise<SecretSummary> {
    const orgId = workspaceOf(auth);
    const replaced = await this.vault.has(orgId, name);
    const stored = await this.vault.put(orgId, name, value, auth.userId);
    await this.audit.record({
      auth,
      action: replaced ? 'secrets.updated' : 'secrets.created',
      entityType: 'secret',
      entityId: name,
      metadata: { last4: stored.last4, keyVersion: stored.keyVersion },
    });
    return this.summaries.summary(name, stored);
  }
}

@Injectable()
export class DeleteSecretCommand {
  constructor(
    private readonly vault: SecretsVault,
    private readonly audit: AuditLogger,
  ) {}

  @Transactional()
  async execute(auth: AuthContext, name: SecretName): Promise<void> {
    if (!(await this.vault.delete(workspaceOf(auth), name))) throw new NotFoundError('Secret', name);
    await this.audit.record({
      auth,
      action: 'secrets.deleted',
      entityType: 'secret',
      entityId: name,
    });
  }
}

/** Audited by the controller (`@Audited('secrets.tested')`): the test changes nothing. */
@Injectable()
export class TestSecretCommand {
  constructor(
    private readonly testers: ConnectionTesterRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(auth: AuthContext, name: SecretName): Promise<SecretTestResult> {
    const result = await this.testers.test(workspaceOf(auth), name);
    return { ...result, testedAt: this.clock.now().toISOString() };
  }
}
