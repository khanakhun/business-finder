import {
  ConfirmAssetOwnershipRequestSchema,
  CreateSiteAssetUploadRequestSchema,
  type SiteAsset,
  type SiteAssetList,
  SiteAssetListSchema,
  SiteAssetSchema,
  type SiteAssetSuggestions,
  SiteAssetSuggestionsQuerySchema,
  SiteAssetSuggestionsSchema,
  type SiteAssetUpload,
  SiteAssetUploadSchema,
} from '@bf/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { AssetSourcing } from '../../application/asset-sourcing.ts';
import { SiteAssetCommands } from '../../application/site-assets.ts';
import { SiteThumbnailCommands } from '../../application/site-thumbnails.ts';
import { actorOf } from './sites.controller.ts';

class UploadBody extends zodDto(CreateSiteAssetUploadRequestSchema) {}
class SuggestionsQuery extends zodDto(SiteAssetSuggestionsQuerySchema) {}
class OwnershipBody extends zodDto(ConfirmAssetOwnershipRequestSchema) {}

const THUMBNAIL_KINDS = { desktop: 'desktop', mobile: 'mobile' } as const;

/**
 * A site's images and pictures (BF-035). Images are uploaded straight to storage with a presigned URL, then
 * finalized (checked and queued for processing); the public variants are served by the CDN, never by the API.
 */
@ApiTags('sites')
@Controller('sites')
export class SiteAssetsController {
  constructor(
    private readonly assets: SiteAssetCommands,
    private readonly thumbnails: SiteThumbnailCommands,
    private readonly sourcing: AssetSourcing,
  ) {}

  @Get(':id/asset-suggestions')
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'The site’s images ranked for a role (hero, gallery…), with the reasons',
    operationId: 'suggestSiteAssets',
    query: SuggestionsQuery,
    response: { status: 200, schema: SiteAssetSuggestionsSchema },
    errors: [400, 401, 403, 404],
  })
  async suggestions(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Query() query: SuggestionsQuery,
  ): Promise<SiteAssetSuggestions> {
    return this.sourcing.suggestions(actorOf(auth), siteId, query);
  }

  @Post(':id/assets/refresh')
  @HttpCode(202)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Collect the business’s images again (its website, a wordmark when it has no logo)',
    operationId: 'refreshSiteAssets',
    response: { status: 202, schema: null },
    errors: [401, 403, 404],
  })
  async refresh(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) siteId: string): Promise<void> {
    await this.sourcing.refresh(actorOf(auth), siteId);
  }

  @Post(':id/assets/:assetId/confirm-ownership')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Record that the business owns an image from its website (lifts preview_only)',
    operationId: 'confirmSiteAssetOwnership',
    body: OwnershipBody,
    response: { status: 200, schema: SiteAssetSchema },
    errors: [400, 401, 403, 404, 409],
  })
  async confirmOwnership(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() body: OwnershipBody,
  ): Promise<SiteAsset> {
    return this.sourcing.confirmOwnership(actorOf(auth), siteId, assetId, body);
  }

  @Get(':id/assets')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The site’s images, newest first',
    operationId: 'listSiteAssets',
    response: { status: 200, schema: SiteAssetListSchema },
    errors: [401, 403, 404],
  })
  async list(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) siteId: string): Promise<SiteAssetList> {
    return { items: await this.assets.list(actorOf(auth), siteId) };
  }

  @Post(':id/assets')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Start an image upload: a pending image and a presigned URL to PUT its bytes to',
    operationId: 'createSiteAssetUpload',
    body: UploadBody,
    response: { status: 201, schema: SiteAssetUploadSchema },
    errors: [400, 401, 403, 404],
  })
  createUpload(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() body: UploadBody,
  ): Promise<SiteAssetUpload> {
    return this.assets.createUpload(actorOf(auth), siteId, body);
  }

  @Post(':id/assets/:assetId/finalize')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Check an uploaded image (type, size, dimensions) and queue its processing',
    operationId: 'finalizeSiteAsset',
    response: { status: 200, schema: SiteAssetSchema },
    errors: [401, 403, 404, 409, 422],
  })
  finalize(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ): Promise<SiteAsset> {
    return this.assets.finalize(actorOf(auth), siteId, assetId);
  }

  @Delete(':id/assets/:assetId')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Delete an image no version of the site uses',
    operationId: 'deleteSiteAsset',
    response: { status: 204, schema: null },
    errors: [401, 403, 404, 409],
  })
  async remove(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ): Promise<void> {
    await this.assets.remove(actorOf(auth), siteId, assetId);
  }

  @Get(':id/thumbnails/:kind')
  @RequirePermission('sites:read')
  @ApiProduces('image/png', 'image/jpeg', 'image/webp')
  @ApiRoute({
    summary: 'A picture of the site’s published home page (desktop or mobile)',
    operationId: 'getSiteThumbnail',
    response: { status: 200, schema: null },
    errors: [400, 401, 403, 404],
  })
  async thumbnail(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Param('kind', new ParseEnumPipe(THUMBNAIL_KINDS)) kind: 'desktop' | 'mobile',
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.thumbnails.file(actorOf(auth).organizationId, siteId, kind);
    const type = ['image/png', 'image/jpeg', 'image/webp'].includes(file.contentType)
      ? file.contentType
      : 'image/png';
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new StreamableFile(file.body, { type, length: file.body.length });
  }
}
