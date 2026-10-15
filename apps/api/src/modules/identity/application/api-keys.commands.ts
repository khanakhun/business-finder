import {
  type ApiKeyList,
  type Clock,
  type CreateApiKeyRequest,
  type CreatedApiKey,
  ForbiddenError,
  NotFoundError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '../../platform/clock/clock.module.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { memberActor } from './actor.ts';
import { toApiKeySummary } from './mappers.ts';
import {
  API_KEY_ISSUER,
  API_KEY_REPOSITORY,
  type ApiKeyIssuer,
  type ApiKeyRepository,
  IDENTITY_EVENTS,
  type IdentityEvents,
} from './ports.ts';

const DAY_SECONDS = 24 * 60 * 60;

@Injectable()
export class ListApiKeysQuery {
  constructor(@Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepository) {}

  async execute(auth: AuthContext & { readonly orgId: string }): Promise<ApiKeyList> {
    return { items: (await this.keys.list(auth.orgId)).map(toApiKeySummary) };
  }
}

/** Creates an organization key. It can never do more than its creator can (no privilege escalation). */
@Injectable()
export class CreateApiKeyCommand {
  constructor(
    @Inject(API_KEY_ISSUER) private readonly issuer: ApiKeyIssuer,
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepository,
    @Inject(IDENTITY_EVENTS) private readonly events: IdentityEvents,
  ) {}

  async execute(auth: AuthContext, input: CreateApiKeyRequest): Promise<CreatedApiKey> {
    const actor = memberActor(auth);
    const beyond = input.permissions.filter((p) => !auth.permissions.has(p));
    if (beyond.length > 0) {
      throw new ForbiddenError('A key cannot have permissions you do not have.', { details: { beyond } });
    }
    const issued = await this.issuer.issue({
      organizationId: actor.orgId,
      createdBy: actor.userId,
      name: input.name,
      permissions: [...new Set(input.permissions)],
      expiresInSeconds: input.expiresInDays ? input.expiresInDays * DAY_SECONDS : null,
    });
    const record = await this.keys.find(actor.orgId, issued.id);
    if (!record) throw new NotFoundError('ApiKey', issued.id);
    await this.events.publish(
      { type: 'identity.api_key_created', organizationId: actor.orgId, apiKeyId: issued.id },
      { userId: actor.userId },
    );
    return { ...toApiKeySummary(record), key: issued.key };
  }
}

/** Revokes a key of the caller's workspace (idempotent; keys of other workspaces are not found). */
@Injectable()
export class RevokeApiKeyCommand {
  constructor(
    @Inject(API_KEY_REPOSITORY) private readonly keys: ApiKeyRepository,
    @Inject(IDENTITY_EVENTS) private readonly events: IdentityEvents,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(auth: AuthContext, apiKeyId: string): Promise<void> {
    const actor = memberActor(auth);
    const key = await this.keys.find(actor.orgId, apiKeyId);
    if (!key) throw new NotFoundError('ApiKey', apiKeyId);
    if (key.revokedAt) return;
    await this.keys.revoke(key.id, this.clock.now());
    await this.events.publish(
      { type: 'identity.api_key_revoked', organizationId: actor.orgId, apiKeyId },
      { userId: actor.userId },
    );
  }
}
