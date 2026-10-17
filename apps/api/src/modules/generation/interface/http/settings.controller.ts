import {
  type GenerationSettingsView,
  GenerationSettingsViewSchema,
  UpdateGenerationSettingsRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { GenerationSettingsService } from '../../application/generation.settings.ts';

class UpdateBody extends zodDto(UpdateGenerationSettingsRequestSchema) {}

/** Settings → Generation (BF-046): engines, concurrency, failover, budgets, defaults and assignment presets. */
@ApiTags('generation')
@Controller('generation/settings')
export class GenerationSettingsController {
  constructor(private readonly settings: GenerationSettingsService) {}

  @Get()
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The workspace’s generation settings, and the engines this deployment offers',
    operationId: 'getGenerationSettings',
    response: { status: 200, schema: GenerationSettingsViewSchema },
    errors: [401, 403],
  })
  get(@Ctx() auth: AuthContext): Promise<GenerationSettingsView> {
    if (!auth.orgId) throw new Error('Settings route reached without a workspace');
    return this.settings.view(auth.orgId);
  }

  @Put()
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Replace the workspace’s generation settings',
    operationId: 'updateGenerationSettings',
    body: UpdateBody,
    response: { status: 200, schema: GenerationSettingsViewSchema },
    errors: [400, 401, 403, 422],
  })
  update(@Ctx() auth: AuthContext, @Body() body: UpdateBody): Promise<GenerationSettingsView> {
    if (!auth.orgId || !auth.userId)
      throw new Error('Settings route reached without a member of a workspace');
    return this.settings.update({ organizationId: auth.orgId, userId: auth.userId }, body);
  }
}
