import {
  CreateDraftRequestSchema,
  type EmailDraft,
  EmailDraftSchema,
  RegenerateDraftRequestSchema,
  type RenderedEmail,
  RenderedEmailSchema,
  TranslateDraftRequestSchema,
  UpdateDraftRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { MemberDirectory } from '../../../identity/index.ts';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { type DraftActor, DraftsService } from '../../application/drafting/drafts.service.ts';

class CreateBody extends zodDto(CreateDraftRequestSchema) {}
class UpdateBody extends zodDto(UpdateDraftRequestSchema) {}
class RegenerateBody extends zodDto(RegenerateDraftRequestSchema) {}
class TranslateBody extends zodDto(TranslateDraftRequestSchema) {}

const DraftListSchema = z.object({ items: z.array(EmailDraftSchema) }).meta({ id: 'EmailDraftList' });

/** Email drafts (BF-051): written by AI from facts we can prove or from a template; never sent from here. */
@ApiTags('outreach')
@Controller('outreach/drafts')
export class DraftsController {
  constructor(
    private readonly drafts: DraftsService,
    private readonly members: MemberDirectory,
  ) {}

  private async actor(auth: AuthContext): Promise<DraftActor> {
    if (!auth.orgId) throw new Error('Draft route reached without a workspace');
    const contact = auth.userId ? await this.members.contact(auth.userId) : undefined;
    return {
      organizationId: auth.orgId,
      userId: auth.userId,
      locale: contact?.locale === 'fr' ? 'fr' : 'en',
    };
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Draft an email to a business (AI, grounded in its facts and findings, or from a template)',
    operationId: 'createEmailDraft',
    body: CreateBody,
    response: { status: 201, schema: EmailDraftSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async create(@Ctx() auth: AuthContext, @Body() body: CreateBody): Promise<EmailDraft> {
    return this.drafts.create(await this.actor(auth), body);
  }

  @Get()
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The latest drafts for a business',
    operationId: 'listEmailDrafts',
    response: { status: 200, schema: DraftListSchema },
    errors: [400, 401, 403],
  })
  async list(@Ctx() auth: AuthContext, @Query('businessId', ParseUUIDPipe) businessId: string) {
    return this.drafts.forBusiness(await this.actor(auth), businessId);
  }

  @Get(':id')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'One draft',
    operationId: 'getEmailDraft',
    response: { status: 200, schema: EmailDraftSchema },
    errors: [401, 403, 404],
  })
  async get(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.drafts.get(await this.actor(auth), id);
  }

  @Patch(':id')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Edit a draft (revalidated: the link policy blocks, other checks warn)',
    operationId: 'updateEmailDraft',
    body: UpdateBody,
    response: { status: 200, schema: EmailDraftSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async update(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateBody) {
    return this.drafts.update(await this.actor(auth), id, body);
  }

  @Post(':id/regenerate')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Write the draft again (optionally with instructions)',
    operationId: 'regenerateEmailDraft',
    body: RegenerateBody,
    response: { status: 200, schema: EmailDraftSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async regenerate(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RegenerateBody,
  ) {
    return this.drafts.regenerate(await this.actor(auth), id, body.instructions);
  }

  @Post(':id/translate')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The same draft in the other language (facts kept)',
    operationId: 'translateEmailDraft',
    body: TranslateBody,
    response: { status: 200, schema: EmailDraftSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async translate(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TranslateBody,
  ) {
    return this.drafts.translate(await this.actor(auth), id, body.locale);
  }

  @Get(':id/preview')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The final message (signature and compliance footer included) and today’s compliance decision',
    operationId: 'previewEmailDraft',
    response: { status: 200, schema: RenderedEmailSchema },
    errors: [401, 403, 404],
  })
  async preview(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RenderedEmail> {
    return this.drafts.preview(await this.actor(auth), id);
  }
}
