import {
  ApplySiteOperationsRequestSchema,
  CreateSiteRequestSchema,
  CreateSiteVersionRequestSchema,
  CursorPageRequestSchema,
  ExtendPreviewRequestSchema,
  PublishPreviewRequestSchema,
  RollbackSiteRequestSchema,
  type SiteDetail,
  SiteDetailSchema,
  SiteDiffQuerySchema,
  SiteListQuerySchema,
  type SitePage,
  SitePageSchema,
  type SitePublication,
  SitePublicationSchema,
  type SiteVersion,
  type SiteVersionDiff,
  SiteVersionDiffSchema,
  type SiteVersionPage,
  SiteVersionPageSchema,
  SiteVersionSchema,
  UnpublishSiteRequestSchema,
} from '@bf/contracts';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { toPublication, toVersion } from '../../application/mappers.ts';
import { type SiteActor, SiteCommands } from '../../application/sites.commands.ts';
import { SiteQueries } from '../../application/sites.queries.ts';

class ListQuery extends zodDto(SiteListQuerySchema) {}
class PageQuery extends zodDto(CursorPageRequestSchema) {}
class DiffQuery extends zodDto(SiteDiffQuerySchema) {}
class CreateBody extends zodDto(CreateSiteRequestSchema) {}
class VersionBody extends zodDto(CreateSiteVersionRequestSchema) {}
class OperationsBody extends zodDto(ApplySiteOperationsRequestSchema) {}
class PublishBody extends zodDto(PublishPreviewRequestSchema) {}
class ExtendBody extends zodDto(ExtendPreviewRequestSchema) {}
class UnpublishBody extends zodDto(UnpublishSiteRequestSchema) {}
class RollbackBody extends zodDto(RollbackSiteRequestSchema) {}

/** Routes guarantee an active workspace (`@RequirePermission`); reaching here without one is a wiring bug. */
export function actorOf(auth: AuthContext): SiteActor {
  if (!auth.orgId) throw new Error('Sites route reached without an active workspace');
  return { organizationId: auth.orgId, userId: auth.userId ?? null };
}

/**
 * Sites (BF-035): a workspace's preview websites of businesses, their immutable versions and publications. Another
 * workspace's site is a 404. Edits name the version they start from: a newer one is a 409 with its id.
 */
@ApiTags('sites')
@Controller('sites')
export class SitesController {
  constructor(
    private readonly queries: SiteQueries,
    private readonly commands: SiteCommands,
  ) {}

  @Get()
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The workspace’s sites, newest first',
    operationId: 'listSites',
    query: ListQuery,
    response: { status: 200, schema: SitePageSchema },
    errors: [400, 401, 403],
  })
  list(@Ctx() auth: AuthContext, @Query() query: ListQuery): Promise<SitePage> {
    return this.queries.list(actorOf(auth).organizationId, query);
  }

  @Post()
  // Every write stores a version or a publication row: bounded per user.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary:
      'The business’s site: created (201, with a first version when a spec is given) or the existing one (200)',
    operationId: 'createSite',
    body: CreateBody,
    response: { status: 201, schema: SiteDetailSchema },
    errors: [400, 401, 403, 404, 422],
  })
  async create(
    @Ctx() auth: AuthContext,
    @Body() body: CreateBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SiteDetail> {
    const actor = actorOf(auth);
    const { siteId, created } = await this.commands.create(actor, body);
    res.status(created ? 201 : 200);
    return this.queries.get(actor.organizationId, siteId);
  }

  @Get(':id')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'A site with its current version and active publications',
    operationId: 'getSite',
    response: { status: 200, schema: SiteDetailSchema },
    errors: [401, 403, 404],
  })
  get(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) siteId: string): Promise<SiteDetail> {
    return this.queries.get(actorOf(auth).organizationId, siteId);
  }

  @Get(':id/versions')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'The site’s versions, newest first',
    operationId: 'listSiteVersions',
    query: PageQuery,
    response: { status: 200, schema: SiteVersionPageSchema },
    errors: [400, 401, 403, 404],
  })
  versions(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Query() query: PageQuery,
  ): Promise<SiteVersionPage> {
    return this.queries.versions(actorOf(auth).organizationId, siteId, query);
  }

  @Post(':id/versions')
  // Every write stores a version or a publication row: bounded per user.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Save a new version from a whole spec (validated; 409 when the site has a newer version)',
    operationId: 'createSiteVersion',
    body: VersionBody,
    response: { status: 201, schema: SiteVersionSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  async createVersion(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() body: VersionBody,
  ): Promise<SiteVersion> {
    return toVersion(await this.commands.createVersion(actorOf(auth), siteId, body));
  }

  @Get(':id/versions/:versionId')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'A version with its spec and issues (errors a draft keeps block publishing)',
    operationId: 'getSiteVersion',
    response: { status: 200, schema: SiteVersionSchema },
    errors: [401, 403, 404],
  })
  version(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ): Promise<SiteVersion> {
    return this.queries.version(actorOf(auth).organizationId, siteId, versionId);
  }

  @Post(':id/operations')
  // Every write stores a version or a publication row: bounded per user.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Apply SiteSpec operations atomically as a new version (409 when the site has a newer version)',
    operationId: 'applySiteOperations',
    body: OperationsBody,
    response: { status: 201, schema: SiteVersionSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  async applyOperations(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() body: OperationsBody,
  ): Promise<SiteVersion> {
    return toVersion(await this.commands.applyOperations(actorOf(auth), siteId, body));
  }

  @Get(':id/diff')
  @RequirePermission('sites:read')
  @ApiRoute({
    summary: 'What changed between two versions of the site',
    operationId: 'diffSiteVersions',
    query: DiffQuery,
    response: { status: 200, schema: SiteVersionDiffSchema },
    errors: [400, 401, 403, 404],
  })
  diff(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Query() query: DiffQuery,
  ): Promise<SiteVersionDiff> {
    return this.queries.diff(actorOf(auth).organizationId, siteId, query.from, query.to);
  }

  @Post(':id/rollback')
  // Every write stores a version or a publication row: bounded per user.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('sites:generate')
  @ApiRoute({
    summary: 'Make an earlier version’s content current again, as a new version',
    operationId: 'rollbackSite',
    body: RollbackBody,
    response: { status: 201, schema: SiteVersionSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  async rollback(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() body: RollbackBody,
  ): Promise<SiteVersion> {
    return toVersion(await this.commands.rollback(actorOf(auth), siteId, body));
  }

  @Post(':id/preview')
  // Every write stores a version or a publication row: bounded per user.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Publish a version as the site’s preview (replaces the active one; expires after expiresInDays)',
    operationId: 'publishSitePreview',
    body: PublishBody,
    response: { status: 201, schema: SitePublicationSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  async publishPreview(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() body: PublishBody,
  ): Promise<SitePublication> {
    return toPublication(await this.commands.publishPreview(actorOf(auth), siteId, body));
  }

  @Post(':id/preview/extend')
  @HttpCode(200)
  // Every write stores a version or a publication row: bounded per user.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Extend the active preview (from its expiry, at most 90 days ahead)',
    operationId: 'extendSitePreview',
    body: ExtendBody,
    response: { status: 200, schema: SitePublicationSchema },
    errors: [400, 401, 403, 404, 409],
  })
  async extendPreview(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() body: ExtendBody,
  ): Promise<SitePublication> {
    return toPublication(await this.commands.extendPreview(actorOf(auth), siteId, body.days));
  }

  @Post(':id/unpublish')
  @HttpCode(204)
  // Every write stores a version or a publication row: bounded per user.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Take the site’s publication in an environment offline',
    operationId: 'unpublishSite',
    body: UnpublishBody,
    response: { status: 204, schema: null },
    errors: [400, 401, 403, 404, 409],
  })
  async unpublish(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() body: UnpublishBody,
  ): Promise<void> {
    await this.commands.unpublish(actorOf(auth), siteId, body.environment);
  }

  @Post(':id/archive')
  @HttpCode(204)
  // Every write stores a version or a publication row: bounded per user.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Archive the site: its publications go offline and it no longer changes',
    operationId: 'archiveSite',
    response: { status: 204, schema: null },
    errors: [401, 403, 404],
  })
  async archive(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) siteId: string): Promise<void> {
    await this.commands.archive(actorOf(auth), siteId);
  }
}
