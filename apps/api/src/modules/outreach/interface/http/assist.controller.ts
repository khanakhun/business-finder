import {
  CallListSchema,
  CallScriptRequestSchema,
  CallScriptSchema,
  CallWorkspaceSchema,
  LogOutcomeRequestSchema,
  LogOutcomeResultSchema,
  WhatsAppDraftRequestSchema,
  WhatsAppDraftSchema,
} from '@bf/contracts';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MemberDirectory } from '../../../identity/index.ts';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { CallAssist } from '../../application/assist/call-assist.ts';
import type { DraftActor } from '../../application/drafting/drafts.service.ts';

class ScriptBody extends zodDto(CallScriptRequestSchema) {}
class WhatsAppBody extends zodDto(WhatsAppDraftRequestSchema) {}
class OutcomeBody extends zodDto(LogOutcomeRequestSchema) {}

/**
 * Call and WhatsApp assist (BF-057): the call workspace (numbers, compliance per channel, best time, history), the
 * grounded call script, the WhatsApp draft with its wa.me link, outcome logging (idempotent: the offline queue
 * re-submits) and today's call list. Nothing here dials or sends.
 */
@ApiTags('outreach')
@Controller('outreach/assist')
export class AssistController {
  constructor(
    private readonly assist: CallAssist,
    private readonly members: MemberDirectory,
  ) {}

  private async actor(auth: AuthContext): Promise<DraftActor> {
    if (!auth.orgId) throw new Error('Outreach route reached without a workspace');
    const contact = auth.userId ? await this.members.contact(auth.userId) : undefined;
    return {
      organizationId: auth.orgId,
      userId: auth.userId,
      locale: contact?.locale === 'fr' ? 'fr' : 'en',
    };
  }

  @Get('calls')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Today’s call list: open call tasks and suggested businesses to call now',
    operationId: 'getCallList',
    response: { status: 200, schema: CallListSchema },
    errors: [401, 403],
  })
  async calls(@Ctx() auth: AuthContext) {
    return this.assist.callList(await this.actor(auth));
  }

  @Get('businesses/:businessId')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The call workspace of a business: numbers, channel decisions, best time to call, history',
    operationId: 'getCallWorkspace',
    response: { status: 200, schema: CallWorkspaceSchema },
    errors: [401, 403, 404],
  })
  async workspace(@Ctx() auth: AuthContext, @Param('businessId', ParseUUIDPipe) businessId: string) {
    return this.assist.workspace(await this.actor(auth), businessId);
  }

  @Post('businesses/:businessId/script')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The grounded call script (cached per offer, language and facts; regenerate on demand)',
    operationId: 'getCallScript',
    body: ScriptBody,
    response: { status: 200, schema: CallScriptSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async script(
    @Ctx() auth: AuthContext,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() body: ScriptBody,
  ) {
    return this.assist.callScript(await this.actor(auth), businessId, body);
  }

  @Post('businesses/:businessId/whatsapp')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'A short WhatsApp message with the preview link and its wa.me link (refused when blocked)',
    operationId: 'draftWhatsApp',
    body: WhatsAppBody,
    response: { status: 200, schema: WhatsAppDraftSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async whatsApp(
    @Ctx() auth: AuthContext,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() body: WhatsAppBody,
  ) {
    return this.assist.whatsApp(await this.actor(auth), businessId, body);
  }

  @Post('businesses/:businessId/outcomes')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Log a call or WhatsApp outcome (idempotent by key) and apply its CRM effects',
    operationId: 'logCallOutcome',
    body: OutcomeBody,
    response: { status: 201, schema: LogOutcomeResultSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async outcome(
    @Ctx() auth: AuthContext,
    @Param('businessId', ParseUUIDPipe) businessId: string,
    @Body() body: OutcomeBody,
  ) {
    return this.assist.logOutcome(await this.actor(auth), businessId, body);
  }
}
