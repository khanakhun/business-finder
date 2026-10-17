import {
  ApplyProposalRequestSchema,
  type ApplyProposalResult,
  ApplyProposalResultSchema,
  type SiteChangeProposal,
  SiteChangeProposalSchema,
  type SiteChatThreadDetail,
  SiteChatThreadDetailSchema,
  type SiteChatThreadList,
  SiteChatThreadListSchema,
} from '@bf/contracts';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { type ChatActor, SiteChatProposals } from '../../application/site-chat.proposals.ts';

class ApplyBody extends zodDto(ApplyProposalRequestSchema) {}

function actorOf(auth: AuthContext): ChatActor {
  if (!auth.orgId || !auth.userId) throw new Error('Site chat route reached without a member of a workspace');
  return { organizationId: auth.orgId, userId: auth.userId };
}

/** A site's chat threads and the edit agent's proposals (BF-047): applied or discarded by a person. */
@ApiTags('site-chat')
@Controller('sites/:id')
export class SiteChatController {
  constructor(private readonly proposals: SiteChatProposals) {}

  @Get('chat/threads')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The site’s chat threads, most recent first',
    operationId: 'listSiteChatThreads',
    response: { status: 200, schema: SiteChatThreadListSchema },
    errors: [401, 403, 404],
  })
  threads(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<SiteChatThreadList> {
    return this.proposals.threads(actorOf(auth), id);
  }

  @Get('chat/threads/:threadId')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'A chat thread with its messages and proposals',
    operationId: 'getSiteChatThread',
    response: { status: 200, schema: SiteChatThreadDetailSchema },
    errors: [401, 403, 404],
  })
  thread(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
  ): Promise<SiteChatThreadDetail> {
    return this.proposals.thread(actorOf(auth), id, threadId);
  }

  @Post('proposals/:proposalId/apply')
  @HttpCode(200)
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Apply a proposal as a new version (confirmed facts are stored first; never published)',
    operationId: 'applySiteChangeProposal',
    body: ApplyBody,
    response: { status: 200, schema: ApplyProposalResultSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  apply(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: ApplyBody,
  ): Promise<ApplyProposalResult> {
    return this.proposals.apply(actorOf(auth), id, proposalId, body.confirmFacts ?? []);
  }

  @Post('proposals/:proposalId/discard')
  @HttpCode(200)
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Discard a proposal (nothing changes)',
    operationId: 'discardSiteChangeProposal',
    response: { status: 200, schema: SiteChangeProposalSchema },
    errors: [401, 403, 404, 409],
  })
  discard(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
  ): Promise<SiteChangeProposal> {
    return this.proposals.discard(actorOf(auth), id, proposalId);
  }
}
