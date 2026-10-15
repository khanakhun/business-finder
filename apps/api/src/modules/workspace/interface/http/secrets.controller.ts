import {
  PutSecretRequestSchema,
  type SecretList,
  SecretListSchema,
  type SecretName,
  type SecretSummary,
  SecretSummarySchema,
  type SecretTestResult,
  SecretTestResultSchema,
} from '@bf/contracts';
import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import {
  DeleteSecretCommand,
  ListSecretsQuery,
  PutSecretCommand,
  TestSecretCommand,
} from '../../application/secrets.use-cases.ts';
import { Audited } from './audited.interceptor.ts';
import { SecretNamePipe } from './secret-name.pipe.ts';

class PutSecretBody extends zodDto(PutSecretRequestSchema) {}

const NAME_PARAM = { name: 'name', description: 'Registry key, e.g. google_places.' } as const;

/** Provider credentials (settings:manage). Values are write-only: responses carry metadata only. */
@ApiTags('workspace')
@Controller('workspace/secrets')
export class SecretsController {
  constructor(
    private readonly listSecrets: ListSecretsQuery,
    private readonly putSecret: PutSecretCommand,
    private readonly deleteSecret: DeleteSecretCommand,
    private readonly testSecret: TestSecretCommand,
  ) {}

  @Get()
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Every known secret and whether it is set (never the values)',
    operationId: 'listWorkspaceSecrets',
    response: { status: 200, schema: SecretListSchema },
    errors: [401, 403],
  })
  list(@Ctx() auth: AuthContext): Promise<SecretList> {
    return this.listSecrets.execute(auth);
  }

  @Put(':name')
  @RequirePermission('settings:manage')
  @ApiParam(NAME_PARAM)
  @ApiRoute({
    summary: 'Store or replace a secret',
    operationId: 'putWorkspaceSecret',
    body: PutSecretBody,
    response: { status: 200, schema: SecretSummarySchema },
    errors: [401, 403, 404],
  })
  put(
    @Ctx() auth: AuthContext,
    @Param('name', SecretNamePipe) name: SecretName,
    @Body() body: PutSecretBody,
  ): Promise<SecretSummary> {
    return this.putSecret.execute(auth, name, body.value);
  }

  @Delete(':name')
  @RequirePermission('settings:manage')
  @ApiParam(NAME_PARAM)
  @ApiRoute({
    summary: 'Delete a workspace secret (the global fallback, if any, applies again)',
    operationId: 'deleteWorkspaceSecret',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  async delete(@Ctx() auth: AuthContext, @Param('name', SecretNamePipe) name: SecretName): Promise<void> {
    await this.deleteSecret.execute(auth, name);
  }

  @Post(':name/test')
  @RequirePermission('settings:manage')
  @ApiParam(NAME_PARAM)
  @Audited('secrets.tested', {
    entityType: 'secret',
    entityIdParam: 'name',
    metadata: (result) => {
      const { ok, source } = result as SecretTestResult;
      return { ok, source };
    },
  })
  @ApiRoute({
    summary: 'Check the secret against its provider',
    operationId: 'testWorkspaceSecret',
    response: { status: 200, schema: SecretTestResultSchema },
    errors: [401, 403, 404, 409],
  })
  test(@Ctx() auth: AuthContext, @Param('name', SecretNamePipe) name: SecretName): Promise<SecretTestResult> {
    return this.testSecret.execute(auth, name);
  }
}
