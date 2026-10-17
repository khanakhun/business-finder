import {
  ConfirmContactRoutingRequestSchema,
  GoLiveReadinessSchema,
  PublishLiveRequestSchema,
  PublishLiveResultSchema,
  SaveSiteLegalProfileRequestSchema,
  SetContactRoutingRequestSchema,
  SiteContactRoutingSchema,
  SiteLegalProfileSchema,
} from '@bf/contracts';
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { MemberDirectory } from '../../../identity/index.ts';
import { AllowAnonymous, Ctx, RequirePermission } from '../../../platform/security/auth.decorators.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { type GoLiveActor, GoLiveService } from '../../application/go-live/go-live.service.ts';
import { actorOf } from './sites.controller.ts';

class LegalBody extends zodDto(SaveSiteLegalProfileRequestSchema) {}
class RoutingBody extends zodDto(SetContactRoutingRequestSchema) {}
class PublishLiveBody extends zodDto(PublishLiveRequestSchema) {}
class ConfirmBody extends zodDto(ConfirmContactRoutingRequestSchema) {}
class ReadinessQuery extends zodDto(z.object({ versionId: z.uuid().optional() })) {}

const LegalProfileResultSchema = z
  .object({ profile: SiteLegalProfileSchema.nullable() })
  .meta({ id: 'SiteLegalProfileResult' });
const ConfirmResultSchema = z.object({ confirmed: z.boolean() }).meta({ id: 'ContactRoutingConfirmResult' });

/**
 * Going live (BF-062): readiness, the legal profile, the contact routing address and the live publication. Another
 * workspace's site is a 404.
 */
@ApiTags('sites')
@Controller('sites')
export class GoLiveController {
  constructor(
    private readonly goLive: GoLiveService,
    private readonly members: MemberDirectory,
  ) {}

  private async actor(auth: AuthContext): Promise<GoLiveActor> {
    const contact = auth.userId ? await this.members.contact(auth.userId) : undefined;
    return {
      ...actorOf(auth),
      canOverride: auth.permissions.has('settings:manage'),
      locale: contact?.locale === 'fr' ? 'fr' : 'en',
    };
  }

  @Get(':id/go-live/readiness')
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'The go-live checks of a version (the current one by default)',
    operationId: 'getGoLiveReadiness',
    query: ReadinessQuery,
    response: { status: 200, schema: GoLiveReadinessSchema },
    errors: [401, 403, 404, 409],
  })
  readiness(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ReadinessQuery,
  ) {
    return this.goLive.readiness(actorOf(auth), id, query.versionId);
  }

  @Post(':id/go-live')
  @HttpCode(201)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Publish a version live (422 with the failing checks; a deal override needs settings:manage)',
    operationId: 'publishSiteLive',
    body: PublishLiveBody,
    response: { status: 201, schema: PublishLiveResultSchema },
    errors: [400, 401, 403, 404, 409, 422],
  })
  async publishLive(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PublishLiveBody,
  ) {
    return this.goLive.publishLive(await this.actor(auth), id, body);
  }

  @Get(':id/legal-profile')
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'The legal profile the legal notice and privacy pages are generated from',
    operationId: 'getSiteLegalProfile',
    response: { status: 200, schema: LegalProfileResultSchema },
    errors: [401, 403, 404],
  })
  async legal(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return { profile: await this.goLive.legal(actorOf(auth), id) };
  }

  @Put(':id/legal-profile')
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary:
      'Save the legal profile (each save is a new version; privacy and content confirmations included)',
    operationId: 'saveSiteLegalProfile',
    body: LegalBody,
    response: { status: 200, schema: SiteLegalProfileSchema },
    errors: [400, 401, 403, 404],
  })
  saveLegal(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: LegalBody) {
    return this.goLive.saveLegal(actorOf(auth), id, body);
  }

  @Get(':id/contact-routing')
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Where the live contact form is delivered',
    operationId: 'getSiteContactRouting',
    response: { status: 200, schema: SiteContactRoutingSchema },
    errors: [401, 403, 404],
  })
  routing(@Ctx() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.goLive.routing(actorOf(auth), id);
  }

  @Put(':id/contact-routing')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RequirePermission('sites:publish')
  @ApiRoute({
    summary: 'Set the delivery address: a confirmation link is emailed to it',
    operationId: 'setSiteContactRouting',
    body: RoutingBody,
    response: { status: 200, schema: SiteContactRoutingSchema },
    errors: [400, 401, 403, 404],
  })
  async setRouting(
    @Ctx() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RoutingBody,
  ) {
    return this.goLive.setRouting(await this.actor(auth), id, body);
  }
}

/** The contact routing confirmation link's landing (BF-062): the emailed token is the proof. */
@ApiTags('sites')
@Controller('public/sites')
export class PublicContactRoutingController {
  constructor(private readonly goLive: GoLiveService) {}

  @Post('contact-routing/confirm')
  @HttpCode(200)
  @AllowAnonymous()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiRoute({
    summary: 'Confirm a contact routing address (same answer shape for unknown or expired tokens)',
    operationId: 'confirmSiteContactRouting',
    body: ConfirmBody,
    response: { status: 200, schema: ConfirmResultSchema },
    errors: [400, 429],
  })
  confirm(@Body() body: ConfirmBody) {
    return this.goLive.confirmRouting(body.token);
  }
}
