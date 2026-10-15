import {
  CreateSavedSearchRequestSchema,
  type SavedSearch,
  type SavedSearchPage,
  SavedSearchPageSchema,
  SavedSearchQuerySchema,
  SavedSearchSchema,
  UpdateSavedSearchRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { SavedSearches } from '../../application/collections.ts';

class PageQuery extends zodDto(SavedSearchQuerySchema) {}
class CreateBody extends zodDto(CreateSavedSearchRequestSchema) {}
class UpdateBody extends zodDto(UpdateSavedSearchRequestSchema) {}

const uuid = new ParseUUIDPipe({ version: '7' });

/** Saved searches (BF-022): private to their creator or shared with the workspace; only the creator edits. */
@ApiTags('search')
@Controller('saved-searches')
export class SavedSearchesController {
  constructor(private readonly searches: SavedSearches) {}

  @Get()
  @RequirePermission('business:read')
  @ApiRoute({
    summary: "The workspace's shared saved searches and the caller's private ones, newest first",
    operationId: 'listSavedSearches',
    query: PageQuery,
    response: { status: 200, schema: SavedSearchPageSchema },
    errors: [401, 403],
  })
  index(@Ctx() auth: AuthContext, @Query() query: PageQuery): Promise<SavedSearchPage> {
    return this.searches.list(auth, query);
  }

  @Post()
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Save a search (prompt, intent, filters, sort)',
    operationId: 'createSavedSearch',
    body: CreateBody,
    response: { status: 201, schema: SavedSearchSchema },
    errors: [401, 403],
  })
  create(@Ctx() auth: AuthContext, @Body() body: CreateBody): Promise<SavedSearch> {
    return this.searches.create(auth, body);
  }

  @Get(':id')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'A saved search with its count of new matches since it was last run',
    operationId: 'getSavedSearch',
    response: { status: 200, schema: SavedSearchSchema },
    errors: [400, 401, 403, 404],
  })
  show(@Ctx() auth: AuthContext, @Param('id', uuid) id: string): Promise<SavedSearch> {
    return this.searches.get(auth, id);
  }

  @Patch(':id')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Change a saved search (creator only)',
    operationId: 'updateSavedSearch',
    body: UpdateBody,
    response: { status: 200, schema: SavedSearchSchema },
    errors: [400, 401, 403, 404],
  })
  update(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() body: UpdateBody,
  ): Promise<SavedSearch> {
    return this.searches.update(auth, id, body);
  }

  @Post(':id/run')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Mark a saved search as run: returns it (with new matches until now) and restarts the count',
    operationId: 'runSavedSearch',
    response: { status: 200, schema: SavedSearchSchema },
    errors: [400, 401, 403, 404],
  })
  run(@Ctx() auth: AuthContext, @Param('id', uuid) id: string): Promise<SavedSearch> {
    return this.searches.run(auth, id);
  }

  @Delete(':id')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Delete a saved search (creator only)',
    operationId: 'deleteSavedSearch',
    response: { status: 204, schema: null },
    errors: [400, 401, 403, 404],
  })
  async delete(@Ctx() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.searches.delete(auth, id);
  }
}
