import {
  MergeBusinessesRequestSchema,
  type MergeBusinessesResult,
  MergeBusinessesResultSchema,
  type PossibleDuplicatePage,
  PossibleDuplicatePageSchema,
  PossibleDuplicateQuerySchema,
  ResolvePossibleDuplicateRequestSchema,
  SplitBusinessRequestSchema,
  type SplitBusinessResult,
  SplitBusinessResultSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { ApiRoute } from '../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../platform/validation/zod-dto.ts';
import {
  ListPossibleDuplicatesQuery,
  MergeBusinessesCommand,
  ResolvePossibleDuplicateCommand,
  SplitBusinessCommand,
} from '../application/resolution/merge.commands.ts';

class MergeBody extends zodDto(MergeBusinessesRequestSchema) {}
class SplitBody extends zodDto(SplitBusinessRequestSchema) {}
class DuplicateQueryDto extends zodDto(PossibleDuplicateQuerySchema) {}
class ResolveDuplicateBody extends zodDto(ResolvePossibleDuplicateRequestSchema) {}

/**
 * Entity resolution tools (BF-016): manual merge/split and the possible-duplicates queue. Only businesses the
 * workspace tracks can be touched. Registered before `BusinessesController` so `possible-duplicates` is not read
 * as a business id.
 */
@ApiTags('businesses')
@Controller('businesses')
export class ResolutionController {
  constructor(
    private readonly mergeCommand: MergeBusinessesCommand,
    private readonly splitCommand: SplitBusinessCommand,
    private readonly duplicatesQuery: ListPossibleDuplicatesQuery,
    private readonly resolveCommand: ResolvePossibleDuplicateCommand,
  ) {}

  @Post('merge')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Merge businesses into a survivor (sources, contacts, workspace links move to it)',
    operationId: 'mergeBusinesses',
    body: MergeBody,
    response: { status: 200, schema: MergeBusinessesResultSchema },
    errors: [400, 401, 403, 404, 409],
  })
  merge(@Ctx() auth: AuthContext, @Body() body: MergeBody): Promise<MergeBusinessesResult> {
    return this.mergeCommand.execute(auth, body);
  }

  @Get('possible-duplicates')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Possible duplicates among the businesses the workspace tracks, with explainable scores',
    operationId: 'listPossibleDuplicates',
    query: DuplicateQueryDto,
    response: { status: 200, schema: PossibleDuplicatePageSchema },
    errors: [401, 403],
  })
  duplicates(@Ctx() auth: AuthContext, @Query() query: DuplicateQueryDto): Promise<PossibleDuplicatePage> {
    return this.duplicatesQuery.execute(auth, query);
  }

  @Patch('possible-duplicates/:id')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Dismiss a possible duplicate, or merge the pair',
    operationId: 'resolvePossibleDuplicate',
    body: ResolveDuplicateBody,
    response: { status: 204, schema: null },
    errors: [400, 401, 403, 404, 409],
  })
  async resolve(
    @Ctx() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ResolveDuplicateBody,
  ): Promise<void> {
    await this.resolveCommand.execute(auth, id, body);
  }

  @Post(':id/split')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Move sources to a new business (unmerge) and recompute both',
    operationId: 'splitBusiness',
    body: SplitBody,
    response: { status: 201, schema: SplitBusinessResultSchema },
    errors: [400, 401, 403, 404, 409],
  })
  split(
    @Ctx() auth: AuthContext,
    @Param('id', new ParseUUIDPipe({ version: '7' })) id: string,
    @Body() body: SplitBody,
  ): Promise<SplitBusinessResult> {
    return this.splitCommand.execute(auth, id, body);
  }
}
