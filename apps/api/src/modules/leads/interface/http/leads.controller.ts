import {
  type LeadCounts,
  LeadCountsSchema,
  type LeadListQuery,
  LeadListQuerySchema,
  type SiteLead,
  type SiteLeadPage,
  SiteLeadPageSchema,
  SiteLeadSchema,
  UpdateLeadRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { type InboxActor, LeadsInbox } from '../../application/leads.inbox.ts';

class ListQuery extends zodDto(LeadListQuerySchema) {}
class UpdateBody extends zodDto(UpdateLeadRequestSchema) {}

function actorOf(auth: AuthContext): InboxActor {
  if (!auth.orgId) throw new Error('Leads route reached without a workspace');
  return {
    organizationId: auth.orgId,
    userId: auth.userId ?? '',
    admin: auth.permissions.has('settings:manage'),
  };
}

/** The leads inbox (BF-048): preview claims, contact requests and opt-outs of the workspace. */
@ApiTags('leads')
@Controller('leads')
export class LeadsController {
  constructor(private readonly inbox: LeadsInbox) {}

  @Get()
  @RequirePermission('leads:read')
  @ApiRoute({
    summary: 'The workspace’s leads, newest first (spam only when filtered on)',
    operationId: 'listLeads',
    query: ListQuery,
    response: { status: 200, schema: SiteLeadPageSchema },
    errors: [400, 401, 403],
  })
  list(@Ctx() auth: AuthContext, @Query() query: ListQuery): Promise<SiteLeadPage> {
    return this.inbox.list(actorOf(auth), query as LeadListQuery);
  }

  @Get('counts')
  @RequirePermission('leads:read')
  @ApiRoute({
    summary: 'Leads waiting (the navigation badge)',
    operationId: 'getLeadCounts',
    response: { status: 200, schema: LeadCountsSchema },
    errors: [401, 403],
  })
  counts(@Ctx() auth: AuthContext): Promise<LeadCounts> {
    return this.inbox.counts(actorOf(auth));
  }

  @Get('export.csv')
  @RequirePermission('leads:export')
  @ApiProduces('text/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="leads.csv"')
  @Header('Cache-Control', 'no-store')
  @ApiRoute({
    summary: 'Export the leads matching the filters as CSV (audited)',
    operationId: 'exportLeads',
    query: ListQuery,
    response: { status: 200, schema: null },
    errors: [400, 401, 403],
  })
  exportCsv(@Ctx() auth: AuthContext, @Query() query: ListQuery): Promise<string> {
    return this.inbox.exportCsv(actorOf(auth), query as LeadListQuery);
  }

  @Get(':id')
  @RequirePermission('leads:read')
  @ApiRoute({
    summary: 'One lead',
    operationId: 'getLead',
    response: { status: 200, schema: SiteLeadSchema },
    errors: [401, 403, 404],
  })
  get(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<SiteLead> {
    return this.inbox.get(actorOf(auth), id);
  }

  @Patch(':id')
  @RequirePermission('leads:manage')
  @ApiRoute({
    summary: 'Change a lead’s status or assignee, or add a note',
    operationId: 'updateLead',
    body: UpdateBody,
    response: { status: 200, schema: SiteLeadSchema },
    errors: [400, 401, 403, 404, 422],
  })
  update(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBody,
  ): Promise<SiteLead> {
    return this.inbox.update(actorOf(auth), id, body);
  }
}
