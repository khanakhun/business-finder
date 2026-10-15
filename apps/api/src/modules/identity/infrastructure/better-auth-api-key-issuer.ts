import { toStatements } from '@bf/auth';
import { Inject, Injectable } from '@nestjs/common';
import type { ApiKeyIssuer } from '../application/ports.ts';
import { type Auth, BETTER_AUTH } from './better-auth.provider.ts';

/**
 * Mints organization keys through the api-key plugin (it hashes and stores them). Called server-side with the
 * creator's id: our use case has already checked the caller; the plugin re-checks the member's role.
 */
@Injectable()
export class BetterAuthApiKeyIssuer implements ApiKeyIssuer {
  constructor(@Inject(BETTER_AUTH) private readonly auth: Auth) {}

  async issue(input: Parameters<ApiKeyIssuer['issue']>[0]) {
    const created = await this.auth.api.createApiKey({
      body: {
        name: input.name,
        organizationId: input.organizationId,
        userId: input.createdBy,
        permissions: toStatements(input.permissions),
        metadata: { createdBy: input.createdBy },
        ...(input.expiresInSeconds ? { expiresIn: input.expiresInSeconds } : {}),
      },
    });
    return { id: created.id, key: created.key };
  }
}
