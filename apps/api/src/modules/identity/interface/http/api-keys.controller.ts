import {
  type ApiKeyList,
  ApiKeyListSchema,
  CreateApiKeyRequestSchema,
  type CreatedApiKey,
  CreatedApiKeySchema,
} from '@bf/contracts';
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import {
  CreateApiKeyCommand,
  ListApiKeysQuery,
  RevokeApiKeyCommand,
} from '../../application/api-keys.commands.ts';

class CreateApiKeyBody extends zodDto(CreateApiKeyRequestSchema) {}

/** Organization API keys (settings:manage). The key itself is returned once, at creation. */
@ApiTags('identity')
@Controller('api-keys')
export class ApiKeysController {
  constructor(
    private readonly listKeys: ListApiKeysQuery,
    private readonly createKey: CreateApiKeyCommand,
    private readonly revokeKey: RevokeApiKeyCommand,
  ) {}

  @Get()
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'API keys of the active workspace',
    operationId: 'listApiKeys',
    response: { status: 200, schema: ApiKeyListSchema },
    errors: [401, 403],
  })
  list(@Ctx() auth: AuthContext & { readonly orgId: string }): Promise<ApiKeyList> {
    return this.listKeys.execute(auth);
  }

  @Post()
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Create an API key (the key is shown once)',
    operationId: 'createApiKey',
    body: CreateApiKeyBody,
    response: { status: 201, schema: CreatedApiKeySchema },
    errors: [401, 403],
  })
  create(@Ctx() auth: AuthContext, @Body() body: CreateApiKeyBody): Promise<CreatedApiKey> {
    return this.createKey.execute(auth, body);
  }

  @Delete(':apiKeyId')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Revoke an API key',
    operationId: 'revokeApiKey',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  revoke(
    @Ctx() auth: AuthContext,
    @Param('apiKeyId', new ParseUUIDPipe({ version: '7' })) id: string,
  ): Promise<void> {
    return this.revokeKey.execute(auth, id);
  }
}
