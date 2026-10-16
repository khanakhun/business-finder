import {
  type BusinessFacts,
  BusinessFactsSchema,
  CreateOrgBusinessFactRequestSchema,
  type GenerationBriefPreview,
  GenerationBriefPreviewSchema,
  GenerationBriefQuerySchema,
  type OrgBusinessFact,
  OrgBusinessFactSchema,
  UpdateOrgBusinessFactRequestSchema,
} from '@bf/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { BriefService } from '../../application/brief.service.ts';
import { type FactActor, FactRegistryService } from '../../application/facts.service.ts';

class CreateBody extends zodDto(CreateOrgBusinessFactRequestSchema) {}
class UpdateBody extends zodDto(UpdateOrgBusinessFactRequestSchema) {}
class BriefQuery extends zodDto(GenerationBriefQuerySchema) {}

const uuid = new ParseUUIDPipe({ version: '7' });

function actorOf(auth: AuthContext): FactActor {
  if (!auth.orgId) throw new Error('Facts route reached without an active workspace');
  return { organizationId: auth.orgId, userId: auth.userId ?? null };
}

/** A business's fact registry and generation brief (BF-040), and the workspace's own statements about it. */
@ApiTags('generation')
@Controller('businesses/:id')
export class FactsController {
  constructor(
    private readonly facts: FactRegistryService,
    private readonly briefs: BriefService,
  ) {}

  @Get('generation-brief')
  @RequirePermission('business:read')
  @ApiRoute({
    summary:
      'The brief a generation would start from: page plan, locales, design, warnings and registry counts',
    operationId: 'getGenerationBrief',
    query: BriefQuery,
    response: { status: 200, schema: GenerationBriefPreviewSchema },
    errors: [400, 401, 403, 404, 422],
  })
  brief(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Query() query: BriefQuery,
  ): Promise<GenerationBriefPreview> {
    return this.briefs.preview(actorOf(auth), id, query);
  }

  // DECISION(BF-040): reading the registry needs `business:read` (like every other read of a business); the ticket's
  // `business:write` guards the overlay's changes.
  @Get('facts')
  @RequirePermission('business:read')
  @ApiRoute({
    summary:
      'The fact registry of a business: global facts with their provenance and usage, plus the overlay',
    operationId: 'getBusinessFacts',
    response: { status: 200, schema: BusinessFactsSchema },
    errors: [400, 401, 403, 404],
  })
  registry(@Ctx() auth: AuthContext, @Param('id', uuid) id: string): Promise<BusinessFacts> {
    return this.facts.registry(actorOf(auth), id);
  }

  @Post('facts')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'State a fact about a business for this workspace (the global graph is unchanged)',
    operationId: 'createBusinessFact',
    body: CreateBody,
    response: { status: 201, schema: OrgBusinessFactSchema },
    errors: [400, 401, 403, 404, 422],
  })
  create(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() body: CreateBody,
  ): Promise<OrgBusinessFact> {
    return this.facts.create(actorOf(auth), id, body);
  }

  @Patch('facts/:factId')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Change a fact the workspace stated',
    operationId: 'updateBusinessFact',
    body: UpdateBody,
    response: { status: 200, schema: OrgBusinessFactSchema },
    errors: [400, 401, 403, 404, 422],
  })
  update(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('factId', uuid) factId: string,
    @Body() body: UpdateBody,
  ): Promise<OrgBusinessFact> {
    return this.facts.update(actorOf(auth), id, factId, body);
  }

  @Delete('facts/:factId')
  @HttpCode(204)
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Withdraw a fact the workspace stated',
    operationId: 'deleteBusinessFact',
    response: { status: 204, schema: null },
    errors: [400, 401, 403, 404],
  })
  async remove(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Param('factId', uuid) factId: string,
  ): Promise<void> {
    await this.facts.remove(actorOf(auth), id, factId);
  }
}
