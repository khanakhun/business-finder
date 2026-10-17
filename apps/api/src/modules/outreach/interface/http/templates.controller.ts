import {
  type EmailTemplate,
  EmailTemplateListSchema,
  EmailTemplateSchema,
  LintTemplateResultSchema,
  SaveEmailTemplateRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { type TemplateActor, TemplatesService } from '../../application/drafting/templates.service.ts';

class SaveBody extends zodDto(SaveEmailTemplateRequestSchema) {}

function actorOf(auth: AuthContext): TemplateActor {
  if (!auth.orgId) throw new Error('Template route reached without a workspace');
  return { organizationId: auth.orgId, userId: auth.userId };
}

/** Email templates (BF-051): the seeded EN/FR library and the workspace's own, versioned and linted. */
@ApiTags('templates')
@Controller('templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'The current version of every template (the workspace’s copies over the seeds)',
    operationId: 'listEmailTemplates',
    response: { status: 200, schema: EmailTemplateListSchema },
    errors: [401, 403],
  })
  list(@Ctx() auth: AuthContext, @Query('archived') archived: string | undefined) {
    return this.templates.list(actorOf(auth), archived === 'true');
  }

  @Post('lint')
  @HttpCode(200)
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Lint a template without saving it',
    operationId: 'lintEmailTemplate',
    body: SaveBody,
    response: { status: 200, schema: LintTemplateResultSchema },
    errors: [400, 401, 403],
  })
  lint(@Body() body: SaveBody) {
    return this.templates.lint(body);
  }

  @Post()
  @RequirePermission('templates:manage')
  @ApiRoute({
    summary: 'Create a template (linted; errors refuse it)',
    operationId: 'createEmailTemplate',
    body: SaveBody,
    response: { status: 201, schema: EmailTemplateSchema },
    errors: [400, 401, 403, 422],
  })
  create(@Ctx() auth: AuthContext, @Body() body: SaveBody): Promise<EmailTemplate> {
    return this.templates.create(actorOf(auth), body);
  }

  @Get(':id')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'One template version',
    operationId: 'getEmailTemplate',
    response: { status: 200, schema: EmailTemplateSchema },
    errors: [401, 403, 404],
  })
  get(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(actorOf(auth), id);
  }

  @Get(':id/versions')
  @RequirePermission('outreach:send')
  @ApiRoute({
    summary: 'Every version of a template, newest first',
    operationId: 'listEmailTemplateVersions',
    response: { status: 200, schema: EmailTemplateListSchema },
    errors: [401, 403, 404],
  })
  versions(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.templates.versions(actorOf(auth), id);
  }

  @Post(':id/versions')
  @RequirePermission('templates:manage')
  @ApiRoute({
    summary: 'Save a new version (for a seeded template: the workspace’s own copy)',
    operationId: 'saveEmailTemplateVersion',
    body: SaveBody,
    response: { status: 201, schema: EmailTemplateSchema },
    errors: [400, 401, 403, 404, 422],
  })
  saveVersion(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaveBody) {
    return this.templates.saveVersion(actorOf(auth), id, body);
  }

  @Post(':id/archive')
  @HttpCode(204)
  @RequirePermission('templates:manage')
  @ApiRoute({
    summary: 'Archive a template for the workspace',
    operationId: 'archiveEmailTemplate',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  async archive(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.templates.archive(actorOf(auth), id);
  }
}
