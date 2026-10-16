import { type OrgSettings, OrgSettingsSchema, UpdateOrgSettingsRequestSchema } from '@bf/contracts';
import { Body, Controller, Delete, Get, Patch, Put, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiConsumes, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AnyMember, Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import {
  GetSettingsQuery,
  LogoUseCases,
  UpdateSettingsCommand,
} from '../../application/settings.use-cases.ts';

class UpdateOrgSettingsBody extends zodDto(UpdateOrgSettingsRequestSchema) {}

type WorkspaceAuth = AuthContext & { readonly orgId: string };

/** Workspace identity, address, languages, timezone, feature flags and logo (BF-011). */
@ApiTags('workspace')
@Controller('workspace')
export class WorkspaceSettingsController {
  constructor(
    private readonly getSettings: GetSettingsQuery,
    private readonly updateSettings: UpdateSettingsCommand,
    private readonly logo: LogoUseCases,
  ) {}

  @Get('settings')
  @AnyMember()
  @ApiRoute({
    summary: 'Settings of the active workspace',
    operationId: 'getWorkspaceSettings',
    response: { status: 200, schema: OrgSettingsSchema },
    errors: [401, 403],
  })
  get(@Ctx() auth: AuthContext): Promise<OrgSettings> {
    return this.getSettings.execute(auth);
  }

  @Patch('settings')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Change workspace settings (only the fields sent)',
    operationId: 'updateWorkspaceSettings',
    body: UpdateOrgSettingsBody,
    response: { status: 200, schema: OrgSettingsSchema },
    errors: [401, 403, 409],
  })
  update(@Ctx() auth: AuthContext, @Body() body: UpdateOrgSettingsBody): Promise<OrgSettings> {
    return this.updateSettings.execute(auth, body);
  }

  @Put('logo')
  @RequirePermission('settings:manage')
  @ApiConsumes('image/png', 'image/jpeg', 'image/webp')
  @ApiRoute({
    summary: 'Upload the workspace logo (raw PNG, JPEG or WebP body, ≤ 512 KiB)',
    operationId: 'uploadWorkspaceLogo',
    response: { status: 204, schema: null },
    errors: [401, 403, 422],
  })
  async uploadLogo(@Ctx() auth: WorkspaceAuth, @Req() req: Request): Promise<void> {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    await this.logo.upload(auth, body, req.headers['content-type']);
  }

  @Get('logo')
  @AnyMember()
  @ApiProduces('image/png', 'image/jpeg', 'image/webp')
  @ApiRoute({
    summary: 'The workspace logo image',
    operationId: 'getWorkspaceLogo',
    response: { status: 200, schema: null },
    errors: [401, 403, 404],
  })
  async getLogo(
    @Ctx() auth: AuthContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const logo = await this.logo.get(auth);
    res.setHeader('Cache-Control', 'private, max-age=300');
    // Served as an image only: no sniffing, no script context even if opened directly.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(logo.body, { type: logo.contentType, length: logo.body.length });
  }

  @Delete('logo')
  @RequirePermission('settings:manage')
  @ApiRoute({
    summary: 'Remove the workspace logo',
    operationId: 'deleteWorkspaceLogo',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  async deleteLogo(@Ctx() auth: WorkspaceAuth): Promise<void> {
    await this.logo.remove(auth);
  }
}
