import { SiteViewBeaconSchema } from '@bf/contracts';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { getRequestContext } from '../../../platform/context/request-context.ts';
import { AllowAnonymous } from '../../../platform/security/auth.decorators.ts';
import { ApiRoute } from '../../../platform/validation/api-route.decorator.ts';
import { zodDto } from '../../../platform/validation/zod-dto.ts';
import { SiteViewRecorder } from '../../application/site-views.ts';

class BeaconBody extends zodDto(SiteViewBeaconSchema) {}

/**
 * The view beacon of published sites (BF-035), anonymous: a page sends its site token, page and language. Always
 * 204 (an invalid token counts nothing and says nothing). No event is recorded here: events carry the request's IP
 * and user agent, and views must never store them (the hourly `site.viewed` events come from the worker).
 */
@ApiTags('sites')
@Controller('public/sites')
export class PublicSiteViewsController {
  constructor(private readonly recorder: SiteViewRecorder) {}

  @Post('views')
  @HttpCode(204)
  @AllowAnonymous()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiRoute({
    summary: 'Count a page view of a published site (anonymous beacon; never stores IPs or user agents)',
    operationId: 'recordSiteView',
    body: BeaconBody,
    response: { status: 204, schema: null },
    errors: [400, 429],
  })
  async record(@Body() body: BeaconBody): Promise<void> {
    const request = getRequestContext();
    await this.recorder.record(body, { ip: request?.ip });
  }
}
