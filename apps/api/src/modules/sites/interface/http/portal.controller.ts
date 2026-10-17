import {
  ChangeRequestSchema,
  CreateChangeRequestSchema,
  DecideApprovalSchema,
  InvitePortalClientRequestSchema,
  PortalAttachmentUploadRequestSchema,
  PortalAttachmentUploadSchema,
  PortalGrantSchema,
  PortalLeadSchema,
  PortalSiteSchema,
  PortalStatsSchema,
  RequestApprovalSchema,
  SiteApprovalSchema,
} from '@bf/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Ctx, NoOrgRequired, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { PortalService } from '../../application/client-portal/portal.service.ts';
import { actorOf } from './sites.controller.ts';

class InviteBody extends zodDto(InvitePortalClientRequestSchema) {}
class ApprovalBody extends zodDto(RequestApprovalSchema) {}
class UploadBody extends zodDto(PortalAttachmentUploadRequestSchema) {}
class ChangeBody extends zodDto(CreateChangeRequestSchema) {}
class DecideBody extends zodDto(DecideApprovalSchema) {}

const list = <T extends z.ZodType>(schema: T, id: string) =>
  z.object({ items: z.array(schema) }).meta({ id });
const GrantListSchema = list(PortalGrantSchema, 'PortalGrantList');
const ApprovalListSchema = list(SiteApprovalSchema, 'SiteApprovalList');
const ChangeRequestListSchema = list(ChangeRequestSchema, 'ChangeRequestList');
const PortalSiteListSchema = list(PortalSiteSchema, 'PortalSiteList');
const PortalLeadListSchema = list(PortalLeadSchema, 'PortalLeadList');

/** The agency's side of the client portal (BF-062): invitations, approvals asked, change requests received. */
@ApiTags('sites')
@Controller('sites')
export class SitePortalController {
  constructor(private readonly portal: PortalService) {}

  @Get(':id/portal/grants')
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Who may see the site in the client portal',
    operationId: 'listPortalGrants',
    response: { status: 200, schema: GrantListSchema },
    errors: [401, 403, 404],
  })
  async grants(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { items: await this.portal.grants(actorOf(auth), id) };
  }

  @Post(':id/portal/grants')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Invite the business owner to the client portal (emailed; they sign in with a magic link)',
    operationId: 'invitePortalClient',
    body: InviteBody,
    response: { status: 201, schema: GrantListSchema },
    errors: [400, 401, 403, 404, 409],
  })
  async invite(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: InviteBody) {
    return { items: await this.portal.invite(actorOf(auth), id, body) };
  }

  @Delete(':id/portal/grants/:grantId')
  @HttpCode(204)
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Revoke a client’s portal access (immediate)',
    operationId: 'revokePortalGrant',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  async revoke(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('grantId', ParseUUIDPipe) grantId: string,
  ): Promise<void> {
    await this.portal.revoke(actorOf(auth), id, grantId);
  }

  @Get(':id/portal/approvals')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The approvals asked of the client, with their decisions',
    operationId: 'listSiteApprovals',
    response: { status: 200, schema: ApprovalListSchema },
    errors: [401, 403, 404],
  })
  async approvals(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { items: await this.portal.agencyApprovals(actorOf(auth), id) };
  }

  @Post(':id/portal/approvals')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Ask the client to approve a version (on the site’s preview)',
    operationId: 'requestSiteApproval',
    body: ApprovalBody,
    response: { status: 201, schema: ApprovalListSchema },
    errors: [400, 401, 403, 404],
  })
  async requestApproval(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApprovalBody,
  ) {
    return { items: await this.portal.requestApproval(actorOf(auth), id, body) };
  }

  @Get(':id/portal/change-requests')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The client’s change requests, with one-hour links to their screenshots',
    operationId: 'listSiteChangeRequests',
    response: { status: 200, schema: ChangeRequestListSchema },
    errors: [401, 403, 404],
  })
  async changeRequests(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { items: await this.portal.agencyChangeRequests(actorOf(auth), id) };
  }
}

/**
 * The client portal (BF-062): a signed-in business owner, without a workspace, acting on the sites granted to
 * them only (every handler checks the grant; another site is a 404).
 */
@ApiTags('portal')
@Controller('portal')
export class ClientPortalController {
  constructor(private readonly portal: PortalService) {}

  @Get('sites')
  @NoOrgRequired()
  @ApiRoute({
    summary: 'The sites the signed-in client may see',
    operationId: 'listPortalSites',
    response: { status: 200, schema: PortalSiteListSchema },
    errors: [401, 403],
  })
  async sites(@Ctx() auth: AuthContext) {
    return { items: await this.portal.sites(auth) };
  }

  @Get('sites/:siteId')
  @NoOrgRequired()
  @ApiRoute({
    summary: 'One of the client’s sites',
    operationId: 'getPortalSite',
    response: { status: 200, schema: PortalSiteSchema },
    errors: [401, 403, 404],
  })
  site(@Ctx() auth: AuthContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.portal.site(auth, siteId);
  }

  @Get('sites/:siteId/stats')
  @NoOrgRequired()
  @ApiRoute({
    summary: 'Views (by language, per day) and leads over 30 days',
    operationId: 'getPortalStats',
    response: { status: 200, schema: PortalStatsSchema },
    errors: [401, 403, 404],
  })
  stats(@Ctx() auth: AuthContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.portal.stats(auth, siteId);
  }

  @Get('sites/:siteId/leads')
  @NoOrgRequired()
  @ApiRoute({
    summary: 'The site’s contact requests (spam and opt-outs excluded)',
    operationId: 'listPortalLeads',
    response: { status: 200, schema: PortalLeadListSchema },
    errors: [401, 403, 404],
  })
  async leads(@Ctx() auth: AuthContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return { items: await this.portal.leads(auth, siteId) };
  }

  @Post('sites/:siteId/attachments')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @NoOrgRequired()
  @ApiRoute({
    summary: 'A presigned upload for a change request screenshot (PNG, JPEG or WebP, 5 MB)',
    operationId: 'createPortalAttachment',
    body: UploadBody,
    response: { status: 201, schema: PortalAttachmentUploadSchema },
    errors: [400, 401, 403, 404],
  })
  upload(@Ctx() auth: AuthContext, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: UploadBody) {
    return this.portal.uploadAttachment(auth, siteId, body);
  }

  @Get('sites/:siteId/change-requests')
  @NoOrgRequired()
  @ApiRoute({
    summary: 'The change requests sent for the site',
    operationId: 'listPortalChangeRequests',
    response: { status: 200, schema: ChangeRequestListSchema },
    errors: [401, 403, 404],
  })
  async changeRequests(@Ctx() auth: AuthContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return { items: await this.portal.changeRequests(auth, siteId) };
  }

  @Post('sites/:siteId/change-requests')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @NoOrgRequired()
  @ApiRoute({
    summary: 'Ask the agency for a change (becomes a task for them)',
    operationId: 'createPortalChangeRequest',
    body: ChangeBody,
    response: { status: 201, schema: ChangeRequestSchema },
    errors: [400, 401, 403, 404],
  })
  createChangeRequest(
    @Ctx() auth: AuthContext,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Body() body: ChangeBody,
  ) {
    return this.portal.createChangeRequest(auth, siteId, body);
  }

  @Get('sites/:siteId/approvals')
  @NoOrgRequired()
  @ApiRoute({
    summary: 'The versions proposed for approval',
    operationId: 'listPortalApprovals',
    response: { status: 200, schema: ApprovalListSchema },
    errors: [401, 403, 404],
  })
  async approvals(@Ctx() auth: AuthContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return { items: await this.portal.approvals(auth, siteId) };
  }

  @Post('sites/:siteId/approvals/:approvalId/decision')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @NoOrgRequired()
  @ApiRoute({
    summary: 'Approve a proposed version or ask for changes',
    operationId: 'decidePortalApproval',
    body: DecideBody,
    response: { status: 200, schema: SiteApprovalSchema },
    errors: [400, 401, 403, 404, 409],
  })
  decide(
    @Ctx() auth: AuthContext,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('approvalId', ParseUUIDPipe) approvalId: string,
    @Body() body: DecideBody,
  ) {
    return this.portal.decide(auth, siteId, approvalId, body);
  }
}
