import {
  ApplyProposalRequestSchema,
  type ApplyProposalResult,
  ApplyProposalResultSchema,
  SendSiteChatMessageRequestSchema,
  type SiteChangeProposal,
  SiteChangeProposalSchema,
  type SiteChatThreadDetail,
  SiteChatThreadDetailSchema,
  type SiteChatThreadList,
  SiteChatThreadListSchema,
  TranslateSiteRequestSchema,
  type TranslateSiteResult,
  TranslateSiteResultSchema,
} from '@bf/contracts';
import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { type ChatStreamEvent, SiteChatMessages } from '../../application/site-chat.messages.ts';
import { type ChatActor, SiteChatProposals } from '../../application/site-chat.proposals.ts';

class ApplyBody extends zodDto(ApplyProposalRequestSchema) {}
class SendBody extends zodDto(SendSiteChatMessageRequestSchema) {}
class TranslateBody extends zodDto(TranslateSiteRequestSchema) {}

/** The UI language for the agent's answers (Accept-Language; English unless French is first). */
const uiLanguageOf = (header: string | undefined): 'en' | 'fr' =>
  header?.trim().toLowerCase().startsWith('fr') ? 'fr' : 'en';

function actorOf(auth: AuthContext): ChatActor {
  if (!auth.orgId || !auth.userId) throw new Error('Site chat route reached without a member of a workspace');
  return { organizationId: auth.orgId, userId: auth.userId };
}

/** A site's chat threads and the edit agent's proposals (BF-047): applied or discarded by a person. */
@ApiTags('site-chat')
@Controller('sites/:id')
export class SiteChatController {
  constructor(
    private readonly proposals: SiteChatProposals,
    private readonly messages: SiteChatMessages,
  ) {}

  @Post('chat')
  @RequirePermission('sites:generate')
  @ApiProduces('application/x-ndjson')
  @ApiRoute({
    summary:
      'Send a message to the edit agent; streams newline-delimited JSON events (thread, text, tool, proposal, clarification, refusal, done)',
    operationId: 'sendSiteChatMessage',
    body: SendBody,
    response: { status: 200, schema: null },
    errors: [400, 401, 403, 404, 422],
  })
  async chat(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendBody,
    @Headers('accept-language') language: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    let started = false;
    const emit = (event: ChatStreamEvent) => {
      if (!started) {
        started = true;
        res.status(200);
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    // Errors before the first event (not found, forbidden…) are problem responses; after it, the stream says so.
    await this.messages.send(actorOf(auth), id, body, uiLanguageOf(language), emit);
    res.end();
  }

  @Post('translate')
  @HttpCode(200)
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Ask the edit agent for a translation proposal (missing texts, or all) into a locale',
    operationId: 'translateSite',
    body: TranslateBody,
    response: { status: 200, schema: TranslateSiteResultSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async translate(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TranslateBody,
    @Headers('accept-language') language: string | undefined,
  ): Promise<TranslateSiteResult> {
    const ui = uiLanguageOf(language);
    const target = body.locale.toUpperCase();
    const message =
      body.scope === 'all'
        ? `Translate every text of the site into ${target}, natively (not word for word), keeping the meaning and the facts.`
        : `Write the missing ${target} texts of the site, natively (not word for word), from the texts in the other languages. Change nothing else.`;
    let threadId = '';
    let text = '';
    let proposal: TranslateSiteResult['proposal'] = null;
    await this.messages.send(actorOf(auth), id, { message }, ui, (event) => {
      if (event.type === 'thread') threadId = event.threadId;
      else if (event.type === 'text') text += event.text;
      else if (event.type === 'proposal') proposal = event.proposal;
    });
    return { threadId, proposal, message: text };
  }

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
