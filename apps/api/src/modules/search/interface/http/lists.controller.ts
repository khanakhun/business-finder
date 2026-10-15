import {
  type BusinessList,
  type BusinessListPage,
  BusinessListPageSchema,
  BusinessListSchema,
  CreateListRequestSchema,
  CursorPageRequestSchema,
  ListItemsRequestSchema,
  type ListItemsResult,
  ListItemsResultSchema,
  UpdateListRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { BusinessLists } from '../../application/collections.ts';

class PageQuery extends zodDto(CursorPageRequestSchema) {}
class CreateBody extends zodDto(CreateListRequestSchema) {}
class UpdateBody extends zodDto(UpdateListRequestSchema) {}
class ItemsBody extends zodDto(ListItemsRequestSchema) {}

const uuid = new ParseUUIDPipe({ version: '7' });

/** Hand-curated lists of tracked businesses (BF-022). Their businesses: `GET /v1/businesses?list=<id>`. */
@ApiTags('search')
@Controller('lists')
export class ListsController {
  constructor(private readonly lists: BusinessLists) {}

  @Get()
  @RequirePermission('business:read')
  @ApiRoute({
    summary: "The workspace's lists, newest first",
    operationId: 'listLists',
    query: PageQuery,
    response: { status: 200, schema: BusinessListPageSchema },
    errors: [401, 403],
  })
  index(@Ctx() auth: AuthContext, @Query() query: PageQuery): Promise<BusinessListPage> {
    return this.lists.list(auth, query);
  }

  @Post()
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Create a list (names are unique in the workspace)',
    operationId: 'createList',
    body: CreateBody,
    response: { status: 201, schema: BusinessListSchema },
    errors: [401, 403, 409],
  })
  create(@Ctx() auth: AuthContext, @Body() body: CreateBody): Promise<BusinessList> {
    return this.lists.create(auth, body);
  }

  @Get(':id')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'A list with its item count',
    operationId: 'getList',
    response: { status: 200, schema: BusinessListSchema },
    errors: [400, 401, 403, 404],
  })
  show(@Ctx() auth: AuthContext, @Param('id', uuid) id: string): Promise<BusinessList> {
    return this.lists.get(auth, id);
  }

  @Patch(':id')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Rename a list or change its description',
    operationId: 'updateList',
    body: UpdateBody,
    response: { status: 200, schema: BusinessListSchema },
    errors: [400, 401, 403, 404, 409],
  })
  update(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() body: UpdateBody,
  ): Promise<BusinessList> {
    return this.lists.update(auth, id, body);
  }

  @Delete(':id')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Delete a list (the businesses stay tracked)',
    operationId: 'deleteList',
    response: { status: 204, schema: null },
    errors: [400, 401, 403, 404],
  })
  async delete(@Ctx() auth: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.lists.delete(auth, id);
  }

  @Post(':id/items')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Add up to 1,000 tracked businesses to a list (idempotent)',
    operationId: 'addListItems',
    body: ItemsBody,
    response: { status: 200, schema: ListItemsResultSchema },
    errors: [400, 401, 403, 404],
  })
  add(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() body: ItemsBody,
  ): Promise<ListItemsResult> {
    return this.lists.addItems(auth, id, body.businessIds);
  }

  @Post(':id/items/remove')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Remove up to 1,000 businesses from a list (idempotent)',
    operationId: 'removeListItems',
    body: ItemsBody,
    response: { status: 200, schema: ListItemsResultSchema },
    errors: [400, 401, 403, 404],
  })
  remove(
    @Ctx() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body() body: ItemsBody,
  ): Promise<ListItemsResult> {
    return this.lists.removeItems(auth, id, body.businessIds);
  }
}
