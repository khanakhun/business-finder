import {
  AddContactRequestSchema,
  type BusinessDetail,
  BusinessDetailSchema,
  type BusinessPage,
  BusinessPageSchema,
  type Contact,
  type ContactList,
  ContactListSchema,
  ContactSchema,
  CreateManualBusinessRequestSchema,
  CursorPageRequestSchema,
  type OrgBusinessState,
  OrgBusinessStateSchema,
  TrackBusinessRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../platform/security/auth-context.ts';
import { ApiRoute } from '../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../platform/validation/zod-dto.ts';
import {
  AddContactCommand,
  CreateManualBusinessCommand,
  TrackBusinessCommand,
} from '../application/business.commands.ts';
import {
  GetBusinessDetailQuery,
  ListContactsQuery,
  ListTrackedBusinessesQuery,
} from '../application/business.queries.ts';

class PageQueryDto extends zodDto(CursorPageRequestSchema) {}
class CreateManualBusinessBody extends zodDto(CreateManualBusinessRequestSchema) {}
class TrackBusinessBody extends zodDto(TrackBusinessRequestSchema) {}
class AddContactBody extends zodDto(AddContactRequestSchema) {}

const businessId = () => new ParseUUIDPipe({ version: '7' });

/** Businesses the workspace tracks: global facts (ADR-0008) plus the workspace's state. */
@ApiTags('businesses')
@Controller('businesses')
export class BusinessesController {
  constructor(
    private readonly detailQuery: GetBusinessDetailQuery,
    private readonly listQuery: ListTrackedBusinessesQuery,
    private readonly contactsQuery: ListContactsQuery,
    private readonly createManual: CreateManualBusinessCommand,
    private readonly trackCommand: TrackBusinessCommand,
    private readonly addContactCommand: AddContactCommand,
  ) {}

  @Get()
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'Businesses the workspace tracks, most recently added first',
    operationId: 'listBusinesses',
    query: PageQueryDto,
    response: { status: 200, schema: BusinessPageSchema },
    errors: [401, 403],
  })
  index(@Ctx() auth: AuthContext, @Query() query: PageQueryDto): Promise<BusinessPage> {
    return this.listQuery.execute(auth, query);
  }

  @Post()
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Add a business by hand (tracked by the workspace)',
    operationId: 'createBusiness',
    body: CreateManualBusinessBody,
    response: { status: 201, schema: BusinessDetailSchema },
    errors: [400, 401, 403],
  })
  async create(@Ctx() auth: AuthContext, @Body() body: CreateManualBusinessBody): Promise<BusinessDetail> {
    const id = await this.createManual.execute(auth, body);
    return this.detailQuery.execute(auth, id);
  }

  @Get(':id')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: 'A tracked business with provenance, contacts, categories, hours and media',
    operationId: 'getBusiness',
    response: { status: 200, schema: BusinessDetailSchema },
    errors: [400, 401, 403, 404],
  })
  show(@Ctx() auth: AuthContext, @Param('id', businessId()) id: string): Promise<BusinessDetail> {
    return this.detailQuery.execute(auth, id);
  }

  @Post(':id/track')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Track a business in the workspace (idempotent: 201 when added, 200 when already tracked)',
    operationId: 'trackBusiness',
    body: TrackBusinessBody,
    response: { status: 200, schema: OrgBusinessStateSchema },
    errors: [400, 401, 403, 404, 409],
  })
  async track(
    @Ctx() auth: AuthContext,
    @Param('id', businessId()) id: string,
    @Body() body: TrackBusinessBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrgBusinessState> {
    const { state, created } = await this.trackCommand.execute(auth, id, body);
    res.status(created ? 201 : 200);
    return state;
  }

  @Get(':id/contacts')
  @RequirePermission('business:read')
  @ApiRoute({
    summary: "A tracked business's contact points",
    operationId: 'listBusinessContacts',
    response: { status: 200, schema: ContactListSchema },
    errors: [400, 401, 403, 404],
  })
  contacts(@Ctx() auth: AuthContext, @Param('id', businessId()) id: string): Promise<ContactList> {
    return this.contactsQuery.execute(auth, id);
  }

  @Post(':id/contacts')
  @RequirePermission('business:write')
  @ApiRoute({
    summary: 'Add a contact point by hand (provenance `manual`); an existing one is returned',
    operationId: 'addBusinessContact',
    body: AddContactBody,
    response: { status: 201, schema: ContactSchema },
    errors: [400, 401, 403, 404, 409],
  })
  addContact(
    @Ctx() auth: AuthContext,
    @Param('id', businessId()) id: string,
    @Body() body: AddContactBody,
  ): Promise<Contact> {
    return this.addContactCommand.execute(auth, id, body);
  }
}
